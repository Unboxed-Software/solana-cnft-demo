import dotenv from "dotenv";
import { clusterApiUrl } from "@solana/web3.js";
import { getOrCreateKeypair, airdropSolIfNeeded } from "./utils";
import { mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
import { dasApi } from "@metaplex-foundation/digital-asset-standard-api";
import * as anchor from "@coral-xyz/anchor";
import {
  keypairIdentity,
  Keypair,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";

export const initializeUmi = async () => {
  // const {BN} = anchor.default;

  const umi = createUmi(clusterApiUrl("devnet"));

  //get keypair from .env file or create a new one
  const wallet = await getOrCreateKeypair("Wallet1");

  await airdropSolIfNeeded(wallet.publicKey);

  // convert to Umi compatible keypair
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(wallet.secretKey);

  // Load the DAS API and MPL Bubblegum plugins into Umi, and set the Umi identity using a keypair,
  // which acts as the signer for transactions.
  umi
    .use(keypairIdentity(umiKeypair))
    .use(mplTokenMetadata())
    .use(mplBubblegum())
    .use(dasApi());

  return umi;
};
