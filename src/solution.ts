import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import { airdropSolIfNeeded, getOrCreateKeypair } from "./utils"
import { uris } from "./uri"
import {
  CreateCompressedNftOutput,
  Metaplex,
  keypairIdentity,
} from "@metaplex-foundation/js"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  SPL_NOOP_PROGRAM_ID,
  ConcurrentMerkleTreeAccount,
  deserializeChangeLogEventV1,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createCreateTreeInstruction,
  createMintToCollectionV1Instruction,
  getLeafAssetId,
} from "@metaplex-foundation/mpl-bubblegum"
import { PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata"
import base58 from "bs58"
import BN from "bn.js"

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")
  const wallet = await getOrCreateKeypair("Wallet_1")
  airdropSolIfNeeded(wallet.publicKey)

  const treeAddress = await createTree(connection, wallet)

  const collectionNft = await createCollectionNFT(connection, wallet)

  await mintCompressedNFTtoCollection(
    connection,
    wallet,
    treeAddress,
    collectionNft,
    100
  )
}

async function createCollectionNFT(connection: Connection, payer: Keypair) {
  // Create Metaplex instance using payer as identity
  const metaplex = new Metaplex(connection).use(keypairIdentity(payer))

  // Select a random URI from uris
  const randomUri = uris[Math.floor(Math.random() * uris.length)]

  // Create a regular collection NFT using Metaplex
  const collectionNft = await metaplex.nfts().create({
    uri: randomUri,
    name: "Collection NFT",
    sellerFeeBasisPoints: 0,
    updateAuthority: payer,
    mintAuthority: payer,
    tokenStandard: 0,
    symbol: "Collection",
    isMutable: true,
    isCollection: true,
  })

  return collectionNft
}

async function createTree(connection: Connection, payer: Keypair) {
  const treeKeypair = Keypair.generate()

  const maxDepthSizePair: ValidDepthSizePair = {
    maxDepth: 14,
    maxBufferSize: 64,
  }

  const canopyDepth = 0

  const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
    [treeKeypair.publicKey.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  const allocTreeIx = await createAllocTreeIx(
    connection,
    treeKeypair.publicKey,
    payer.publicKey,
    maxDepthSizePair,
    canopyDepth
  )

  const createTreeIx = createCreateTreeInstruction(
    {
      treeAuthority,
      merkleTree: treeKeypair.publicKey,
      payer: payer.publicKey,
      treeCreator: payer.publicKey,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    },
    {
      maxBufferSize: maxDepthSizePair.maxBufferSize,
      maxDepth: maxDepthSizePair.maxDepth,
      public: false,
    },
    BUBBLEGUM_PROGRAM_ID
  )

  try {
    const tx = new Transaction().add(allocTreeIx, createTreeIx)
    tx.feePayer = payer.publicKey

    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [treeKeypair, payer],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )

    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)

    console.log("Tree Address:", treeKeypair.publicKey.toBase58())

    return treeKeypair.publicKey
  } catch (err: any) {
    console.error("\nFailed to create merkle tree:", err)
    throw err
  }
}

async function mintCompressedNFTtoCollection(
  connection: Connection,
  payer: Keypair,
  treeAddress: PublicKey,
  collectionNft: CreateCompressedNftOutput, // Not compressed nft, just type from metaplex
  amount: number
) {
  // Define the mint address, metadata address, and master edition address of the "collection" NFT
  const collectionDetails = {
    mint: new PublicKey(collectionNft.mintAddress),
    metadata: new PublicKey(collectionNft.metadataAddress),
    masterEditionAccount: new PublicKey(collectionNft.masterEditionAddress),
  }

  // Derive the tree authority PDA ('TreeConfig' account for the tree account)
  const [treeAuthority] = PublicKey.findProgramAddressSync(
    [treeAddress.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  // Derive the bubblegum signer, used by the Bubblegum program to handle "collection verification"
  // Only used for `createMintToCollectionV1` instruction
  const [bubblegumSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("collection_cpi", "utf8")],
    BUBBLEGUM_PROGRAM_ID
  )

  for (let i = 0; i < amount; i++) {
    // Compressed NFT Metadata
    const compressedNFTMetadata = createCompressedNFTMetadata(payer.publicKey)

    // Create the instruction to "mint" the compressed NFT to the tree
    const mintIx = createMintToCollectionV1Instruction(
      {
        payer: payer.publicKey, // The account that will pay for the transaction
        merkleTree: treeAddress, // The address of the tree account
        treeAuthority, // The authority of the tree account, should be a PDA derived from the tree account address
        treeDelegate: payer.publicKey, // The delegate of the tree account, should be the same as the tree creator by default
        leafOwner: payer.publicKey, // The owner of the compressed NFT being minted to the tree
        leafDelegate: payer.publicKey, // The delegate of the compressed NFT being minted to the tree
        collectionAuthority: payer.publicKey, // The authority of the "collection" NFT
        collectionAuthorityRecordPda: BUBBLEGUM_PROGRAM_ID, // Not sure what this is used for, by default uses Bubblegum program id
        collectionMint: collectionDetails.mint, // The mint of the "collection" NFT
        collectionMetadata: collectionDetails.metadata, // The metadata of the "collection" NFT
        editionAccount: collectionDetails.masterEditionAccount, // The master edition of the "collection" NFT
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        bubblegumSigner,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      },
      {
        metadataArgs: Object.assign(compressedNFTMetadata, {
          collection: { key: collectionDetails.mint, verified: false },
        }),
      }
    )

    try {
      // Create new transaction and add the instruction
      const tx = new Transaction().add(mintIx)

      // Set the fee payer for the transaction
      tx.feePayer = payer.publicKey

      // Send the transaction
      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        [payer],
        { commitment: "confirmed", skipPreflight: true }
      )

      console.log(
        `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`
      )

      await extractAssetId(connection, txSignature, treeAddress)
    } catch (err) {
      console.error("\nFailed to mint compressed NFT:", err)
      throw err
    }
  }
}

function createCompressedNFTMetadata(creatorPublicKey: PublicKey) {
  // Select a random URI from uris
  const randomUri = uris[Math.floor(Math.random() * uris.length)]

  // Compressed NFT Metadata
  const compressedNFTMetadata: MetadataArgs = {
    name: "CNFT",
    symbol: "CNFT",
    uri: randomUri,
    creators: [{ address: creatorPublicKey, verified: false, share: 100 }],
    editionNonce: 0,
    uses: null,
    collection: null,
    primarySaleHappened: false,
    sellerFeeBasisPoints: 0,
    isMutable: false,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.NonFungible,
  }

  return compressedNFTMetadata
}

async function extractAssetId(
  connection: Connection,
  txSignature: string,
  treeAddress: PublicKey
) {
  // Get the transaction info using the tx signature
  const txInfo = await connection.getTransaction(txSignature, {
    maxSupportedTransactionVersion: 0,
  })

  // Function to check the program Id of an instruction
  const isProgramId = (instruction, programId) =>
    txInfo?.transaction.message.staticAccountKeys[
      instruction.programIdIndex
    ].toBase58() === programId

  // Find the index of the bubblegum instruction
  const relevantIndex =
    txInfo!.transaction.message.compiledInstructions.findIndex((instruction) =>
      isProgramId(instruction, BUBBLEGUM_PROGRAM_ID.toBase58())
    )

  // If there's no matching Bubblegum instruction, exit
  if (relevantIndex < 0) {
    return
  }

  // Get the inner instructions related to the bubblegum instruction
  const relevantInnerInstructions =
    txInfo!.meta?.innerInstructions?.[relevantIndex].instructions

  // Filter out the instructions that aren't no-ops
  const relevantInnerIxs = relevantInnerInstructions.filter((instruction) =>
    isProgramId(instruction, SPL_NOOP_PROGRAM_ID.toBase58())
  )

  // Locate the asset index by attempting to locate and parse the correct `relevantInnerIx`
  let assetIndex
  // Note: the `assetIndex` is expected to be at position `1`, and we normally expect only 2 `relevantInnerIx`
  for (let i = relevantInnerIxs.length - 1; i >= 0; i--) {
    try {
      // Try to decode and deserialize the instruction
      const changeLogEvent = deserializeChangeLogEventV1(
        Buffer.from(base58.decode(relevantInnerIxs[i]?.data!))
      )

      // extract a successful changelog index
      assetIndex = changeLogEvent?.index

      // If we got a valid index, no need to continue the loop
      if (assetIndex !== undefined) {
        break
      }
    } catch (__) {}
  }

  const assetId = await getLeafAssetId(treeAddress, new BN(assetIndex))

  console.log("Asset ID:", assetId.toBase58())

  return assetId
}

main()
