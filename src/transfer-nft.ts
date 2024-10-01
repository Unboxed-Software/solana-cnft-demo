import dotenv from "dotenv";
import { transfer } from "@metaplex-foundation/mpl-bubblegum";
import {
  base58,
  generateSigner,
  publicKey,
  PublicKey,
} from "@metaplex-foundation/umi";
import { getExplorerLink } from "@solana-developers/helpers";
import { Keypair } from "@solana/web3.js";
import { initializeUmi } from ".";
import { getLeafAssetId } from "./get-leaf-assetId";

dotenv.config();

const umi = await initializeUmi();

async function transferNft(
  assetId: PublicKey,
  sender: Keypair,
  receiver: PublicKey
) {
  if (!process.env.RPC_URL) {
    throw new Error("RPC_URL environment variable is not defined.");
  }
  try {
    const assetWithProof = umi.rpc.getAssetWithProof(assetId);

    const { signature } = await transfer(umi, {
      ...assetWithProof,
      leafOwner: umi.identity.publicKey,
      newLeafOwner: receiver,
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    //  TO DO
    const transactionSignature = base58.deserialize(signature);

    const explorerLink = getExplorerLink(
      "transaction",
      transactionSignature.toLocaleString(),
      "devnet"
    );

    console.log(`Transaction submitted: ${explorerLink}`);
  } catch (error: any) {
    console.error("\nFailed to transfer nft:", error);
    throw error;
  }
}

// Transfer first cNFT to random receiver to illustrate transfers
const receiver = Keypair.generate()

transferNft(
  await getLeafAssetId(publicKey(treeAddress), new BN(0)),
  wallet,
  publicKey(receiver.publicKey)
);
