import dotenv from "dotenv";
import { publicKey, PublicKey } from "@metaplex-foundation/umi";
import BN from "bn.js";
import { maxDepthSizePair } from "./create-and-initialize-tree";
import { getLeafAssetId } from "./get-leaf-assetId";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { dasApi } from "@metaplex-foundation/digital-asset-standard-api";

dotenv.config();

async function logNftDetails(nftsMinted: number) {
  if (!process.env.RPC_URL) {
    throw new Error("RPC_URL environment variable is not defined.");
  }
  if (!process.env.MERKLE_TREE_ADDRESS) {
    throw new Error("No MERKLE_TREE_ADDRESS found");
  }
  const treeAddress = process.env["MERKLE_TREE_ADDRESS"];

  for (let i = 0; i < nftsMinted; i++) {
    const assetId = await getLeafAssetId(publicKey(treeAddress), new BN(i));

    console.log("Asset ID:", assetId);

    const umi = createUmi(process.env.RPC_URL).use(dasApi());

    const result = await umi.rpc.getAsset(assetId);

    return result;
  }
}

// Log NFT details to illustrate Read API
logNftDetails(2 ** maxDepthSizePair.maxDepth);
