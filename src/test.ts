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
  deserializeChangeLogEventV1,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createCreateTreeInstruction,
  createMintToCollectionV1Instruction,
  createTransferInstruction,
  getLeafAssetId,
} from "@metaplex-foundation/mpl-bubblegum"
import { PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata"
import {
  CreateCompressedNftOutput,
  keypairIdentity,
  Metaplex,
  toBigNumber,
} from "@metaplex-foundation/js"
import fetch from "node-fetch"
import base58 from "bs58"
import { BN } from "bn.js"

describe("Compressed NFTs", () => {
  const rpcUrl = process.env.RPC_URL
  const connection = new Connection(rpcUrl, "confirmed")
  const treeKeypair = Keypair.generate()

  let payer: Keypair

  // Output of `metaplex.nfts().create`.
  // Type naming is a bit confusing, not a compressed nft
  let collectionNft: CreateCompressedNftOutput

  let cnfts: any[] = []

  before(async () => {
    payer = await initializeKeypair(connection)

    const metaplex = new Metaplex(connection).use(keypairIdentity(payer))

    // Create a regular collection NFT using Metaplex
    collectionNft = await metaplex.nfts().create({
      uri: "https://madlads.s3.us-west-2.amazonaws.com/json/2382.json", // Off-chain metadata
      name: "Collection NFT",
      sellerFeeBasisPoints: 0,
      updateAuthority: payer,
      mintAuthority: payer,
      tokenStandard: 0,
      symbol: "Collection",
      isMutable: true,
      isCollection: true,
    })
  })

  it("Create Tree", async () => {
    // Define our tree size parameters
    const maxDepthSizePair: ValidDepthSizePair = {
      maxDepth: 3, // 2^maxDepth = maximum number of nodes in the tree
      maxBufferSize: 8, // determines maximum number of concurrent updates that can be applied to the tree in a single slot
    }

    // Determine the amount of proof stored on chain
    // Larger canopyDepth means more proof is stored on chain and cost more SOL to initialize the tree
    // But less of the proof needs to be provided by the client as remaining accounts in an instruction
    const canopyDepth = 0

    // For the Bubblegum program, the tree authority is a program derived address using the tree account address as the seed
    // This allows the Bubblegum program to "sign" transactions to update the tree
    const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
      [treeKeypair.publicKey.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    )

    // Instruction to create a new account with the space required for the tree
    const allocTreeIx = await createAllocTreeIx(
      connection,
      treeKeypair.publicKey, // The address of the tree account to create
      payer.publicKey, // The account that will pay for the transaction
      maxDepthSizePair, // The tree size parameters
      canopyDepth // The amount of proof stored on chain
    )

    // Instruction to initialize the tree
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
        public: false, // Whether the tree is public or private, public trees allow anyone to update the tree
      },
      BUBBLEGUM_PROGRAM_ID
    )

    try {
      // Create new transaction and add the instructions
      const tx = new Transaction().add(allocTreeIx, createTreeIx)

      // Set the fee payer for the transaction
      tx.feePayer = payer.publicKey

      // Send the transaction
      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        [treeKeypair, payer], // treeKeypair must be included as a signer because the publickey is used as the address of the tree account being created
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
    // Tree address of the tree created previously
    const treeAddress = treeKeypair.publicKey

    // Define the mint address, metadata address, and master edition address of the "collection" NFT
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

    // Derive the tree authority
    const [treeAuthority] = PublicKey.findProgramAddressSync(
      [treeAddress.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    )

    // Derive the bubblegum signer
    const [bubblegumSigner] = PublicKey.findProgramAddressSync(
      [Buffer.from("collection_cpi", "utf8")],
      BUBBLEGUM_PROGRAM_ID
    )

    // Create the instruction to "mint" the compressed NFT to the tree
    const mintIx = createMintToCollectionV1Instruction(
      {
        payer: payer.publicKey, // The account that will pay for the transaction
        merkleTree: treeAddress, // The address of the tree account
        treeAuthority, // The authority of the tree account, should be a PDA derived from the tree account address
        treeDelegate: payer.publicKey,
        leafOwner: payer.publicKey, // The owner of the compressed NFT
        leafDelegate: payer.publicKey,
        collectionAuthority: payer.publicKey,
        collectionAuthorityRecordPda: BUBBLEGUM_PROGRAM_ID,
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

      // get the transaction info using the tx signature
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
        txInfo!.transaction.message.compiledInstructions.findIndex(
          (instruction) =>
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
      console.log("assetId:", assetId.toBase58())
    } catch (err) {
      console.error("\nFailed to mint compressed NFT:", err)
      throw err
    }
  })

  // it("Fetch NFTs and Filter by Collection", async () => {
  //   const response = await fetch(rpcUrl, {
  //     method: "POST",
  //     headers: {
  //       "Content-Type": "application/json",
  //     },
  //     body: JSON.stringify({
  //       jsonrpc: "2.0",
  //       id: "my-id",
  //       method: "getAssetsByOwner",
  //       params: {
  //         ownerAddress: payer.publicKey.toBase58(),
  //         page: 1, // Starts at 1
  //         limit: 1000,
  //       },
  //     }),
  //   })

  //   const { result } = await response.json()

  //   // Filter items to only include those from a specific collection.
  //   const mintAddress = collectionNft.mintAddress.toBase58()
  //   cnfts = result.items?.filter((item) =>
  //     item.grouping.some((group) => group.group_value === mintAddress)
  //   )
  // })

  // it("Transfer Compressed NFT", async () => {
  //   // Define constants
  //   const cnft = cnfts[0]
  //   console.log("assetId:", cnft.id)
  //   const compression = cnft.compression
  //   const treePublicKey = treeKeypair.publicKey

  //   // Fetch the asset proof.
  //   const response = await fetch(rpcUrl, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       jsonrpc: "2.0",
  //       id: "my-id",
  //       method: "getAssetProof",
  //       params: { id: cnft.id },
  //     }),
  //   })

  //   const { result } = await response.json()
  //   // console.log("Assets Proof: ", result)

  //   // Fetch the tree account.
  //   const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
  //     connection,
  //     treePublicKey
  //   )

  //   const ownerPublicKey = new PublicKey(cnft.ownership.owner)
  //   const delegatePublicKey = cnft.ownership.delegate
  //     ? new PublicKey(cnft.ownership.delegate)
  //     : ownerPublicKey

  //   // Define keys for the new and current leaf owners.
  //   // const newLeafOwner = Keypair.generate().publicKey
  //   const leafOwner = ownerPublicKey
  //   const leafDelegate = delegatePublicKey

  //   // Get the tree authority and canopy depth.
  //   const treeAuthority = treeAccount.getAuthority()
  //   const canopyDepth = treeAccount.getCanopyDepth() || 0 // default to 0 if undefined.

  //   // Parse the list of proof addresses into a valid AccountMeta[].
  //   const proofPath: AccountMeta[] = result.proof
  //     .map((node: string) => ({
  //       pubkey: new PublicKey(node),
  //       isSigner: false,
  //       isWritable: false,
  //     }))
  //     .slice(0, result.proof.length - canopyDepth)

  //   // Create the transfer instruction.
  //   const transferIx = createTransferInstruction(
  //     {
  //       merkleTree: treePublicKey,
  //       treeAuthority,
  //       leafOwner,
  //       leafDelegate,
  //       newLeafOwner: payer.publicKey, // transfer to self for testing
  //       logWrapper: SPL_NOOP_PROGRAM_ID,
  //       compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  //       anchorRemainingAccounts: proofPath,
  //     },
  //     {
  //       root: [...new PublicKey(result.root.trim()).toBytes()],
  //       dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()],
  //       creatorHash: [
  //         ...new PublicKey(compression.creator_hash.trim()).toBytes(),
  //       ],
  //       nonce: compression.leaf_id,
  //       index: compression.leaf_id,
  //     },
  //     BUBBLEGUM_PROGRAM_ID
  //   )

  //   try {
  //     // create and send the transaction to transfer ownership of the NFT
  //     const tx = new Transaction().add(transferIx)
  //     tx.feePayer = payer.publicKey

  //     const txSignature = await sendAndConfirmTransaction(
  //       connection,
  //       tx,
  //       [payer],
  //       {
  //         commitment: "confirmed",
  //         skipPreflight: true,
  //       }
  //     )

  //     console.log(
  //       `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`
  //     )
  //   } catch (err: any) {
  //     console.error("\nFailed to transfer nft:", err)
  //     throw err
  //   }
  // })
})
