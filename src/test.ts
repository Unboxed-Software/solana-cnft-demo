import { initializeKeypair } from "./initializeKeypair"
import {
  PublicKey,
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  AccountMeta,
} from "@solana/web3.js"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  SPL_NOOP_PROGRAM_ID,
  ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createCreateTreeInstruction,
  createMintToCollectionV1Instruction,
  createTransferInstruction,
} from "@metaplex-foundation/mpl-bubblegum"
import { PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata"
import {
  CreateCompressedNftOutput,
  keypairIdentity,
  Metaplex,
} from "@metaplex-foundation/js"
import fetch from "node-fetch"

describe("Compressed NFTs", () => {
  const rpcUrl = process.env.RPC_URL
  const connection = new Connection(rpcUrl, "confirmed")
  const treeKeypair = Keypair.generate()

  let payer: Keypair
  let collectionNft: CreateCompressedNftOutput

  let cnfts: any[] = []

  before(async () => {
    payer = await initializeKeypair(connection)

    const metaplex = new Metaplex(connection).use(keypairIdentity(payer))

    collectionNft = await metaplex.nfts().create({
      uri: "https://madlads.s3.us-west-2.amazonaws.com/json/2382.json",
      name: "Collection NFT",
      sellerFeeBasisPoints: 100,
      updateAuthority: payer,
      mintAuthority: payer,
      tokenStandard: 0,
      symbol: "Collection",
      isMutable: true,
      isCollection: true,
    })
  })

  it("Create Tree", async () => {
    const maxDepthSizePair: ValidDepthSizePair = {
      maxDepth: 3,
      maxBufferSize: 8,
    }

    const canopyDepth = maxDepthSizePair.maxDepth - 5

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
        payer: payer.publicKey,
        treeCreator: payer.publicKey,
        treeAuthority,
        merkleTree: treeKeypair.publicKey,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
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

      console.log(
        `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`
      )
    } catch (err: any) {
      console.error("\nFailed to create merkle tree:", err)

      throw err
    }
  })

  it("Mint Compressed NFT to Tree", async () => {
    // Define constants
    const treeAddress = treeKeypair.publicKey
    const collectionDetails = {
      mint: new PublicKey(collectionNft.mintAddress),
      metadata: new PublicKey(collectionNft.metadataAddress),
      masterEditionAccount: new PublicKey(collectionNft.masterEditionAddress),
    }

    // Compressed NFT Metadata
    const compressedNFTMetadata: MetadataArgs = {
      name: "CNFT",
      symbol: "CNFT",
      uri: "https://madlads.s3.us-west-2.amazonaws.com/json/8566.json",
      creators: [{ address: payer.publicKey, verified: false, share: 100 }],
      editionNonce: 0,
      uses: null,
      collection: null,
      primarySaleHappened: false,
      sellerFeeBasisPoints: 0,
      isMutable: false,
      tokenProgramVersion: TokenProgramVersion.Original,
      tokenStandard: TokenStandard.NonFungible,
    }

    const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
      [treeAddress.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    )

    const [bubblegumSigner, _bump2] = PublicKey.findProgramAddressSync(
      [Buffer.from("collection_cpi", "utf8")],
      BUBBLEGUM_PROGRAM_ID
    )

    // Create the mint instruction.
    const mintIx = createMintToCollectionV1Instruction(
      {
        payer: payer.publicKey,
        merkleTree: treeAddress,
        treeAuthority,
        treeDelegate: payer.publicKey,
        leafOwner: payer.publicKey,
        leafDelegate: payer.publicKey,
        collectionAuthority: payer.publicKey,
        collectionAuthorityRecordPda: BUBBLEGUM_PROGRAM_ID,
        collectionMint: collectionDetails.mint,
        collectionMetadata: collectionDetails.metadata,
        editionAccount: collectionDetails.masterEditionAccount,
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
      const tx = new Transaction().add(mintIx)
      tx.feePayer = payer.publicKey
      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        [payer],
        { commitment: "confirmed", skipPreflight: true }
      )

      console.log(
        `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`
      )
    } catch (err) {
      console.error("\nFailed to mint compressed NFT:", err)
      throw err
    }
  })

  it("Fetch NFTs and Filter by Collection", async () => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "my-id",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: payer.publicKey.toBase58(),
          page: 1, // Starts at 1
          limit: 1000,
        },
      }),
    })

    const { result } = await response.json()

    // Filter items to only include those from a specific collection.
    const mintAddress = collectionNft.mintAddress.toBase58()
    cnfts = result.items?.filter((item) =>
      item.grouping.some((group) => group.group_value === mintAddress)
    )
  })

  it("Transfer Compressed NFT", async () => {
    // Define constants
    const cnft = cnfts[0]
    const compression = cnft.compression
    const treePublicKey = treeKeypair.publicKey

    // Fetch the asset proof.
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "my-id",
        method: "getAssetProof",
        params: { id: cnft.id },
      }),
    })

    const { result } = await response.json()
    // console.log("Assets Proof: ", result)

    // Fetch the tree account.
    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treePublicKey
    )

    const ownerPublicKey = new PublicKey(cnft.ownership.owner)
    const delegatePublicKey = cnft.ownership.delegate
      ? new PublicKey(cnft.ownership.delegate)
      : ownerPublicKey

    // Define keys for the new and current leaf owners.
    // const newLeafOwner = Keypair.generate().publicKey
    const leafOwner = ownerPublicKey
    const leafDelegate = delegatePublicKey

    // Get the tree authority and canopy depth.
    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth() || 0 // default to 0 if undefined.

    // Parse the list of proof addresses into a valid AccountMeta[].
    const proofPath: AccountMeta[] = result.proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, result.proof.length - canopyDepth)

    // Create the transfer instruction.
    const transferIx = createTransferInstruction(
      {
        merkleTree: treePublicKey,
        treeAuthority,
        leafOwner,
        leafDelegate,
        newLeafOwner: payer.publicKey, // transfer to self for testing
        logWrapper: SPL_NOOP_PROGRAM_ID,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        anchorRemainingAccounts: proofPath,
      },
      {
        root: [...new PublicKey(result.root.trim()).toBytes()],
        dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()],
        creatorHash: [
          ...new PublicKey(compression.creator_hash.trim()).toBytes(),
        ],
        nonce: compression.leaf_id,
        index: compression.leaf_id,
      },
      BUBBLEGUM_PROGRAM_ID
    )

    try {
      // create and send the transaction to transfer ownership of the NFT
      const tx = new Transaction().add(transferIx)
      tx.feePayer = payer.publicKey

      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        [payer],
        {
          commitment: "confirmed",
          skipPreflight: true,
        }
      )

      console.log(
        `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`
      )
    } catch (err: any) {
      console.error("\nFailed to transfer nft:", err)
      throw err
    }
  })
})
