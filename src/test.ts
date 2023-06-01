import { initializeKeypair } from "./initializeKeypair"
import {
  PublicKey,
  Connection,
  clusterApiUrl,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  getConcurrentMerkleTreeAccountSize,
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
import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  CreateMetadataAccountArgsV3,
} from "@metaplex-foundation/mpl-token-metadata"
import {
  CreateCompressedNftOutput,
  keypairIdentity,
  Metaplex,
} from "@metaplex-foundation/js"
import fetch from "node-fetch"

describe("Test", () => {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")
  const treeKeypair = Keypair.generate()

  let user: Keypair
  let collectionNft: CreateCompressedNftOutput

  let cnfts: any[] = []

  before(async () => {
    user = await initializeKeypair(connection)

    const metaplex = new Metaplex(connection).use(keypairIdentity(user))

    collectionNft = await metaplex.nfts().create({
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
  })

  it("Merkle Tree Creation", async () => {
    const maxDepthSizePair: ValidDepthSizePair = {
      maxDepth: 3,
      maxBufferSize: 8,
    }

    const canopyDepth = maxDepthSizePair.maxDepth - 5

    const tree = await createTree(
      connection,
      user,
      treeKeypair,
      maxDepthSizePair,
      canopyDepth
    )
  })

  it("Mint Compressed NFT", async () => {
    // use similar parameters as used in the main() function
    const compressedNFTMetadata: MetadataArgs = {
      name: "JPEG",
      symbol: "JPEG",
      uri: "https://madlads.s3.us-west-2.amazonaws.com/json/8566.json",
      creators: [
        {
          address: user.publicKey,
          verified: false,
          share: 100,
        },
      ],
      editionNonce: 0,
      uses: null,
      collection: null,
      primarySaleHappened: false,
      sellerFeeBasisPoints: 0,
      isMutable: false,
      tokenProgramVersion: TokenProgramVersion.Original,
      tokenStandard: TokenStandard.NonFungible,
    }

    // assuming you have a valid treeAddress, collectionMint, collectionMetadata, collectionMasterEditionAccount
    const treeAddress = treeKeypair.publicKey
    const collectionMint = new PublicKey(collectionNft.mintAddress)
    const collectionMetadata = new PublicKey(collectionNft.metadataAddress)
    const collectionMasterEditionAccount = new PublicKey(
      collectionNft.masterEditionAddress
    )

    await mintCompressedNFT(
      connection,
      user,
      treeAddress,
      collectionMint,
      collectionMetadata,
      collectionMasterEditionAccount,
      compressedNFTMetadata,
      user.publicKey
    )

    await mintCompressedNFT(
      connection,
      user,
      treeAddress,
      collectionMint,
      collectionMetadata,
      collectionMasterEditionAccount,
      compressedNFTMetadata,
      user.publicKey
    )
  })

  it("getAssetsByOwner", async () => {
    const response = await fetch(process.env.RPC_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "my-id",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: user.publicKey.toBase58(),
          page: 1, // Starts at 1
          limit: 1000,
        },
      }),
    })
    const { result } = await response.json()
    // console.log(JSON.stringify(result, null, 2))
    // console.log(result)
    const filteredItems = result.items
      ?.filter((item) =>
        item.grouping.some(
          (group) => group.group_value === collectionNft.mintAddress.toBase58()
        )
      )
      .map((item) => {
        // display some info about the item
        console.log("itemId:", item.id)
        console.log("ownership:", item.ownership)
        console.log("compression:", item.compression)

        // return an object with the info about the item
        // return item.id
        return item
      })
    console.log("Assets by Group: ", filteredItems)

    cnfts = filteredItems
  })

  it("transfer cnft", async () => {
    const cnft = cnfts[0]
    console.log("cnft", cnft)

    const response = await fetch(process.env.RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "my-id",
        method: "getAssetProof",
        params: {
          id: cnft.id, // compressed nft asset id
        },
      }),
    })
    const { result } = await response.json()
    console.log("Assets Proof: ", result)

    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treeKeypair.publicKey
    )

    const newLeafOwner = Keypair.generate().publicKey
    const leafOwner = new PublicKey(cnft.ownership.owner)
    const leafDelegate = !!cnft.ownership?.delegate
      ? new PublicKey(cnft.ownership.delegate)
      : leafOwner

    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth()

    // parse the list of proof addresses into a valid AccountMeta[]
    const proofPath: AccountMeta[] = result.proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, result.proof.length - (!!canopyDepth ? canopyDepth : 0))

    const transferIx = createTransferInstruction(
      {
        merkleTree: treeKeypair.publicKey,
        treeAuthority,
        leafOwner,
        leafDelegate,
        newLeafOwner,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        anchorRemainingAccounts: proofPath,
      },
      {
        root: [...new PublicKey(result.root.trim()).toBytes()],
        dataHash: [
          ...new PublicKey(cnft.compression.data_hash.trim()).toBytes(),
        ],
        creatorHash: [
          ...new PublicKey(cnft.compression.creator_hash.trim()).toBytes(),
        ],
        nonce: cnft.compression.leaf_id,
        index: cnft.compression.leaf_id,
      },
      BUBBLEGUM_PROGRAM_ID
    )

    try {
      // create and send the transaction to transfer ownership of the NFT
      const tx = new Transaction().add(transferIx)
      tx.feePayer = user.publicKey

      // send the transaction
      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        // ensuring the feePayer signs the transaction
        [user],
        {
          commitment: "confirmed",
          skipPreflight: true,
        }
      )

      console.log("\nTransfer successful!\n", explorerURL({ txSignature }))
    } catch (err: any) {
      console.error("\nFailed to create transfer nft:", err)

      console.log("\n=======================")
      console.log("  Transfer failed!")
      console.log("=======================")

      // log a block explorer link for the failed transaction

      throw err
    }
  })
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
    const tx = new Transaction().add(allocTreeIx, createTreeIx)
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
