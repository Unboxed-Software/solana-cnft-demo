import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js"

import * as fs from "fs"
import fetch from "node-fetch"
import dotenv from "dotenv"
import {
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import {
  SPL_NOOP_PROGRAM_ID,
  deserializeChangeLogEventV1,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  getLeafAssetId,
} from "@metaplex-foundation/mpl-bubblegum"
import { uris } from "./uri"
import base58 from "bs58"
import BN from "bn.js"
dotenv.config()

// This function will return an existing keypair if it's present in the environment variables, or generate a new one if not
export async function getOrCreateKeypair(walletName: string): Promise<Keypair> {
  // Check if secretKey for `walletName` exist in .env file
  const envWalletKey = process.env[walletName]

  let keypair: Keypair

  // If no secretKey exist in the .env file for `walletName`
  if (!envWalletKey) {
    console.log(`Writing ${walletName} keypair to .env file...`)

    // Generate a new keypair
    keypair = Keypair.generate()

    // Save to .env file
    fs.appendFileSync(
      ".env",
      `\n${walletName}=${JSON.stringify(Array.from(keypair.secretKey))}`
    )
  }
  // If secretKey already exists in the .env file
  else {
    // Create a Keypair from the secretKey
    const secretKey = new Uint8Array(JSON.parse(envWalletKey))
    keypair = Keypair.fromSecretKey(secretKey)
  }

  // Log public key and return the keypair
  console.log(`${walletName} PublicKey: ${keypair.publicKey.toBase58()}`)
  return keypair
}

export async function airdropSolIfNeeded(publicKey: PublicKey) {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")

  const balance = await connection.getBalance(publicKey)
  console.log("Current balance is", balance / LAMPORTS_PER_SOL)

  if (balance < 1 * LAMPORTS_PER_SOL) {
    try {
      console.log("Airdropping 2 SOL...")

      const txSignature = await connection.requestAirdrop(
        publicKey,
        2 * LAMPORTS_PER_SOL
      )

      const latestBlockHash = await connection.getLatestBlockhash()

      await connection.confirmTransaction(
        {
          blockhash: latestBlockHash.blockhash,
          lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
          signature: txSignature,
        },
        "confirmed"
      )

      const newBalance = await connection.getBalance(publicKey)
      console.log("New balance is", newBalance / LAMPORTS_PER_SOL)
    } catch (e) {
      console.log("Airdrop Unsuccessful, likely rate-limited. Try again later.")
    }
  }
}

export async function transferSolIfNeeded(sender: Keypair, receiver: Keypair) {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")

  const balance = await connection.getBalance(receiver.publicKey)
  console.log("Current balance is", balance / LAMPORTS_PER_SOL)

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    try {
      let ix = SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver.publicKey,
        lamports: LAMPORTS_PER_SOL,
      })

      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [
        sender,
      ])

      const newBalance = await connection.getBalance(receiver.publicKey)
      console.log("New balance is", newBalance / LAMPORTS_PER_SOL)
    } catch (e) {
      console.log("SOL Transfer Unsuccessful")
    }
  }
}

export async function heliusApi(method, params) {
  const response = await fetch(process.env.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "my-id",
      method,
      params,
    }),
  })
  const { result } = await response.json()
  return result
}

export function createCompressedNFTMetadata(creatorPublicKey: PublicKey) {
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

export async function extractAssetId(
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
