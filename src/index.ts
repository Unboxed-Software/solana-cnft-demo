import { initializeKeypair } from "./initializeKeypair"
import {
  PublicKey,
  Connection,
  clusterApiUrl,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  getConcurrentMerkleTreeAccountSize,
  SPL_NOOP_PROGRAM_ID,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createCreateTreeInstruction,
  createMintToCollectionV1Instruction,
} from "@metaplex-foundation/mpl-bubblegum"
import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  CreateMetadataAccountArgsV3,
} from "@metaplex-foundation/mpl-token-metadata"
import { keypairIdentity, Metaplex, toBigNumber } from "@metaplex-foundation/js"

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")
  const user = await initializeKeypair(connection)

  /*
    Define our tree size parameters
  */
  const maxDepthSizePair: ValidDepthSizePair = {
    // max=8 nodes
    maxDepth: 3,
    maxBufferSize: 8,

    // max=16,384 nodes
    // maxDepth: 14,
    // maxBufferSize: 64,

    // max=131,072 nodes
    // maxDepth: 17,
    // maxBufferSize: 64,

    // max=1,048,576 nodes
    // maxDepth: 20,
    // maxBufferSize: 256,

    // max=1,073,741,824 nodes
    // maxDepth: 30,
    // maxBufferSize: 2048,
  }
  const canopyDepth = maxDepthSizePair.maxDepth - 5

  // calculate the space available in the tree
  const requiredSpace = getConcurrentMerkleTreeAccountSize(
    maxDepthSizePair.maxDepth,
    maxDepthSizePair.maxBufferSize,
    canopyDepth
  )

  const storageCost = await connection.getMinimumBalanceForRentExemption(
    requiredSpace
  )

  // define the address the tree will live at
  const treeKeypair = Keypair.generate()

  // create and send the transaction to create the tree on chain
  const tree = await createTree(
    connection,
    user,
    treeKeypair,
    maxDepthSizePair,
    canopyDepth
  )

  const metaplex = new Metaplex(connection).use(keypairIdentity(user))

  const nft = await metaplex.nfts().create({
    uri: "https://madlads.s3.us-west-2.amazonaws.com/json/2382.json",
    name: "JPEG",
    sellerFeeBasisPoints: 100,
    updateAuthority: user,
    mintAuthority: user,
    tokenStandard: 0,
    symbol: "JPEG",
    isMutable: true,
    isCollection: true,
  })

  console.log(nft)

  const compressedNFTMetadata: MetadataArgs = {
    name: "JPEG",
    symbol: "JPEG",
    // specific json metadata for each NFT
    uri: "https://madlads.s3.us-west-2.amazonaws.com/json/8566.json",
    creators: [
      {
        address: user.publicKey,
        verified: false,
        share: 100,
      },
    ], // or set to null
    editionNonce: 0,
    uses: null,
    collection: null,
    primarySaleHappened: false,
    sellerFeeBasisPoints: 0,
    isMutable: false,
    // these values are taken from the Bubblegum package
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.NonFungible,
  }

  await mintCompressedNFT(
    connection,
    user,
    treeKeypair.publicKey,
    new PublicKey(nft.mintAddress),
    new PublicKey(nft.metadataAddress),
    new PublicKey(nft.masterEditionAddress),
    compressedNFTMetadata,
    // mint to this specific wallet (in this case, airdrop to `testWallet`)
    user.publicKey
  )
}

main()
  .then(() => {
    console.log("Finished successfully")
    process.exit(0)
  })
  .catch((error) => {
    console.log(error)
    process.exit(1)
  })

async function createTree(
  connection: Connection,
  payer: Keypair,
  treeKeypair: Keypair,
  maxDepthSizePair: ValidDepthSizePair,
  canopyDepth: number = 0
) {
  console.log("Creating a new Merkle tree...")
  console.log("treeAddress:", treeKeypair.publicKey.toBase58())

  // derive the tree's authority (PDA), owned by Bubblegum
  const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
    [treeKeypair.publicKey.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )
  console.log("treeAuthority:", treeAuthority.toBase58())

  // allocate the tree's account on chain with the `space`
  // NOTE: this will compute the space needed to store the tree on chain (and the lamports required to store it)
  const allocTreeIx = await createAllocTreeIx(
    connection,
    treeKeypair.publicKey,
    payer.publicKey,
    maxDepthSizePair,
    canopyDepth
  )

  // create the instruction to actually create the tree
  const createTreeIx = createCreateTreeInstruction(
    {
      payer: payer.publicKey,
      treeCreator: payer.publicKey,
      treeAuthority,
      merkleTree: treeKeypair.publicKey,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      // NOTE: this is used for some on chain logging
      logWrapper: SPL_NOOP_PROGRAM_ID,
    },
    {
      maxBufferSize: maxDepthSizePair.maxBufferSize,
      maxDepth: maxDepthSizePair.maxDepth,
      public: false,
    },
    BUBBLEGUM_PROGRAM_ID
  )

  try {
    // create and send the transaction to initialize the tree
    const tx = new Transaction().add(allocTreeIx).add(createTreeIx)
    tx.feePayer = payer.publicKey

    // send the transaction
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      // ensuring the `treeKeypair` PDA and the `payer` are BOTH signers
      [treeKeypair, payer],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )

    console.log("\nMerkle tree created successfully!")
    console.log(explorerURL({ txSignature }))

    // return useful info
    return { treeAuthority, treeAddress: treeKeypair.publicKey }
  } catch (err: any) {
    console.error("\nFailed to create merkle tree:", err)

    throw err
  }
}

async function mintCompressedNFT(
  connection: Connection,
  payer: Keypair,
  treeAddress: PublicKey,
  collectionMint: PublicKey,
  collectionMetadata: PublicKey,
  collectionMasterEditionAccount: PublicKey,
  compressedNFTMetadata: MetadataArgs,
  receiverAddress?: PublicKey
) {
  // derive the tree's authority (PDA), owned by Bubblegum
  const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
    [treeAddress.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  // derive a PDA (owned by Bubblegum) to act as the signer of the compressed minting
  const [bubblegumSigner, _bump2] = PublicKey.findProgramAddressSync(
    // `collection_cpi` is a custom prefix required by the Bubblegum program
    [Buffer.from("collection_cpi", "utf8")],
    BUBBLEGUM_PROGRAM_ID
  )

  // create an array of instruction, to mint multiple compressed NFTs at once
  const mintIxs: TransactionInstruction[] = []

  /*
    Add a single mint instruction
    ---
    But you could all multiple in the same transaction, as long as your
    transaction is still within the byte size limits
  */
  mintIxs.push(
    createMintToCollectionV1Instruction(
      {
        payer: payer.publicKey,

        merkleTree: treeAddress,
        treeAuthority,
        treeDelegate: payer.publicKey,

        // set the receiver of the NFT
        leafOwner: receiverAddress || payer.publicKey,
        // set a delegated authority over this NFT
        leafDelegate: payer.publicKey,

        /*
            You can set any delegate address at mint, otherwise should
            normally be the same as `leafOwner`
            NOTE: the delegate will be auto cleared upon NFT transfer
            ---
            in this case, we are setting the payer as the delegate
          */

        // collection details
        collectionAuthority: payer.publicKey,
        collectionAuthorityRecordPda: BUBBLEGUM_PROGRAM_ID,
        collectionMint: collectionMint,
        collectionMetadata: collectionMetadata,
        editionAccount: collectionMasterEditionAccount,

        // other accounts
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        bubblegumSigner: bubblegumSigner,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      },
      {
        metadataArgs: Object.assign(compressedNFTMetadata, {
          collection: { key: collectionMint, verified: false },
        }),
      }
    )
  )

  try {
    // construct the transaction with our instructions, making the `payer` the `feePayer`
    const tx = new Transaction().add(...mintIxs)
    tx.feePayer = payer.publicKey

    // send the transaction to the cluster
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [payer],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )

    console.log("\nSuccessfully minted the compressed NFT!")
    console.log(explorerURL({ txSignature }))

    return txSignature
  } catch (err) {
    console.error("\nFailed to mint compressed NFT:", err)

    throw err
  }
}

function explorerURL({
  address,
  txSignature,
  cluster,
}: {
  address?: string
  txSignature?: string
  cluster?: "devnet" | "testnet" | "mainnet" | "mainnet-beta"
}) {
  let baseUrl: string
  //
  if (address) baseUrl = `https://explorer.solana.com/address/${address}`
  else if (txSignature)
    baseUrl = `https://explorer.solana.com/tx/${txSignature}`
  else return "[unknown]"

  // auto append the desired search params
  const url = new URL(baseUrl)
  url.searchParams.append("cluster", cluster || "devnet")
  return url.toString() + "\n"
}
