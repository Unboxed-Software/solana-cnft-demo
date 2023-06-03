import * as web3 from "@solana/web3.js"
import * as fs from "fs"
import fetch from "node-fetch"
import dotenv from "dotenv"
dotenv.config()

export async function getOrCreateKeypair(
  walletName: string
): Promise<web3.Keypair> {
  let keypair: web3.Keypair

  const privateKeyEnvironmentVariable = `${walletName}_PRIVATE_KEY`
  if (!process.env[privateKeyEnvironmentVariable]) {
    console.log(`Writing ${walletName} keypair to .env file...`)
    keypair = web3.Keypair.generate()
    fs.appendFileSync(
      ".env",
      `\n${privateKeyEnvironmentVariable}=[${keypair.secretKey.toString()}]\n`
    )
  } else {
    const secret = JSON.parse(
      process.env[privateKeyEnvironmentVariable] ?? ""
    ) as number[]
    const secretKey = Uint8Array.from(secret)
    keypair = web3.Keypair.fromSecretKey(secretKey)
  }

  console.log(`${walletName} PublicKey:`, keypair.publicKey.toBase58())
  return keypair
}

export async function airdropSolIfNeeded(publicKey: web3.PublicKey) {
  const connection = new web3.Connection(
    web3.clusterApiUrl("devnet"),
    "confirmed"
  )

  const balance = await connection.getBalance(publicKey)
  console.log("Current balance is", balance / web3.LAMPORTS_PER_SOL)

  if (balance < 1 * web3.LAMPORTS_PER_SOL) {
    try {
      console.log("Airdropping 2 SOL...")

      const txSignature = await connection.requestAirdrop(
        publicKey,
        2 * web3.LAMPORTS_PER_SOL
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
      console.log("New balance is", newBalance / web3.LAMPORTS_PER_SOL)
    } catch (e) {
      console.log("Airdrop Unsuccessful, likely rate-limited. Try again later.")
    }
  }
}

export async function transferSolIfNeeded(
  sender: web3.Keypair,
  receiver: web3.Keypair
) {
  const connection = new web3.Connection(
    web3.clusterApiUrl("devnet"),
    "confirmed"
  )

  const balance = await connection.getBalance(receiver.publicKey)
  console.log("Current balance is", balance / web3.LAMPORTS_PER_SOL)

  if (balance < 0.5 * web3.LAMPORTS_PER_SOL) {
    try {
      let ix = web3.SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver.publicKey,
        lamports: web3.LAMPORTS_PER_SOL,
      })

      await web3.sendAndConfirmTransaction(
        connection,
        new web3.Transaction().add(ix),
        [sender]
      )

      const newBalance = await connection.getBalance(receiver.publicKey)
      console.log("New balance is", newBalance / web3.LAMPORTS_PER_SOL)
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
