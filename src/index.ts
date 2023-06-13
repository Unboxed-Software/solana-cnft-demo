import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import {
  airdropSolIfNeeded,
  getOrCreateKeypair,
  heliusApi,
  createCompressedNFTMetadata,
  extractAssetId,
} from "./utils"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  SPL_NOOP_PROGRAM_ID,
  ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  createCreateTreeInstruction,
  createMintV1Instruction,
  createTransferInstruction,
  createBurnInstruction,
} from "@metaplex-foundation/mpl-bubblegum"

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")
  const wallet = await getOrCreateKeypair("Wallet_1")
  const wallet2 = await getOrCreateKeypair("Wallet_2")
  airdropSolIfNeeded(wallet.publicKey)

  const maxDepthSizePair: ValidDepthSizePair = {
    maxDepth: 3,
    maxBufferSize: 8,
  }

  const canopyDepth = 0

  const treeAddress = await createTree(
    connection,
    wallet,
    maxDepthSizePair,
    canopyDepth
  )

  const assetId1 = await mintCompressedNFT(connection, wallet, treeAddress)
  const assetId2 = await mintCompressedNFT(connection, wallet, treeAddress)

  await transferCompressedNFT(connection, assetId1, wallet, wallet2)
  await burnCompressedNFT(connection, assetId2, wallet)
}

async function createTree(
  connection: Connection,
  payer: Keypair,
  maxDepthSizePair: ValidDepthSizePair,
  canopyDepth: number
) {
  const treeKeypair = Keypair.generate()

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

async function mintCompressedNFT(
  connection: Connection,
  payer: Keypair,
  treeAddress: PublicKey
) {
  // Compressed NFT Metadata
  const compressedNFTMetadata = createCompressedNFTMetadata(payer.publicKey)

  // Derive the tree authority PDA ('TreeConfig' account for the tree account)
  const [treeAuthority] = PublicKey.findProgramAddressSync(
    [treeAddress.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  // Create the instruction to "mint" the compressed NFT to the tree
  const mintIx = createMintV1Instruction(
    {
      payer: payer.publicKey, // The account that will pay for the transaction
      merkleTree: treeAddress, // The address of the tree account
      treeAuthority, // The authority of the tree account, should be a PDA derived from the tree account address
      treeDelegate: payer.publicKey, // The delegate of the tree account, should be the same as the tree creator by default
      leafOwner: payer.publicKey, // The owner of the compressed NFT being minted to the tree
      leafDelegate: payer.publicKey, // The delegate of the compressed NFT being minted to the tree
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
    },
    {
      message: Object.assign(compressedNFTMetadata),
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

    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)

    const assetId = await extractAssetId(connection, txSignature, treeAddress)
    return assetId
  } catch (err) {
    console.error("\nFailed to mint compressed NFT:", err)
    throw err
  }
}

async function transferCompressedNFT(
  connection: Connection,
  assetId: PublicKey,
  sender: Keypair,
  receiver: Keypair
) {
  try {
    const [assetData, assetProofData] = await Promise.all([
      heliusApi("getAsset", { id: assetId.toBase58() }),
      heliusApi("getAssetProof", { id: assetId.toBase58() }),
    ])

    const { compression, ownership } = assetData
    const { proof, root } = assetProofData

    const treePublicKey = new PublicKey(compression.tree)
    const ownerPublicKey = new PublicKey(ownership.owner)
    const delegatePublicKey = ownership.delegate
      ? new PublicKey(ownership.delegate)
      : ownerPublicKey

    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treePublicKey
    )
    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth() || 0

    const proofPath: AccountMeta[] = proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, proof.length - canopyDepth)

    const newLeafOwner = receiver.publicKey

    const transferIx = createTransferInstruction(
      {
        merkleTree: treePublicKey,
        treeAuthority,
        leafOwner: ownerPublicKey,
        leafDelegate: delegatePublicKey,
        newLeafOwner,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        anchorRemainingAccounts: proofPath,
      },
      {
        root: [...new PublicKey(root.trim()).toBytes()],
        dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()],
        creatorHash: [
          ...new PublicKey(compression.creator_hash.trim()).toBytes(),
        ],
        nonce: compression.leaf_id,
        index: compression.leaf_id,
      },
      BUBBLEGUM_PROGRAM_ID
    )

    const tx = new Transaction().add(transferIx)
    tx.feePayer = sender.publicKey
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [sender],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )
    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)
  } catch (err: any) {
    console.error("\nFailed to transfer nft:", err)
    throw err
  }
}

async function burnCompressedNFT(
  connection: Connection,
  assetId: PublicKey,
  payer: Keypair
) {
  try {
    const [assetData, assetProofData] = await Promise.all([
      heliusApi("getAsset", { id: assetId.toBase58() }),
      heliusApi("getAssetProof", { id: assetId.toBase58() }),
    ])

    const { compression, ownership } = assetData
    const { proof, root } = assetProofData

    const treePublicKey = new PublicKey(compression.tree)
    const ownerPublicKey = new PublicKey(ownership.owner)
    const delegatePublicKey = ownership.delegate
      ? new PublicKey(ownership.delegate)
      : ownerPublicKey

    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treePublicKey
    )
    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth() || 0

    const proofPath: AccountMeta[] = proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, proof.length - canopyDepth)

    const burnIx = createBurnInstruction(
      {
        treeAuthority,
        leafOwner: ownerPublicKey,
        leafDelegate: delegatePublicKey,
        merkleTree: treePublicKey,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        anchorRemainingAccounts: proofPath,
      },
      {
        root: [...new PublicKey(root.trim()).toBytes()],
        dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()],
        creatorHash: [
          ...new PublicKey(compression.creator_hash.trim()).toBytes(),
        ],
        nonce: compression.leaf_id,
        index: compression.leaf_id,
      },
      BUBBLEGUM_PROGRAM_ID
    )

    const tx = new Transaction().add(burnIx)
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
    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)
  } catch (err: any) {
    console.error("\nFailed to burn NFT:", err)
    throw err
  }
}

main()
