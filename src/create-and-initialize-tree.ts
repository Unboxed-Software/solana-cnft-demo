import * as fs from "fs";
import dotenv from "dotenv";
import { createTree } from "@metaplex-foundation/mpl-bubblegum";
import { generateSigner, publicKey } from "@metaplex-foundation/umi";
import { getExplorerLink } from "@solana-developers/helpers";
import { ValidDepthSizePair } from "@solana/spl-account-compression";
import { initializeUmi } from ".";

dotenv.config();

const umi = await initializeUmi();

export const maxDepthSizePair: ValidDepthSizePair = {
  maxDepth: 14,
  maxBufferSize: 64,
};

async function createAndInitializeTree(maxDepthSizePair: ValidDepthSizePair) {
  try {
    const merkleTree = generateSigner(umi);

    const builder = await createTree(umi, {
      merkleTree,
      maxDepth: maxDepthSizePair.maxDepth, // Max depth of the tree,
      maxBufferSize: maxDepthSizePair.maxBufferSize, // Max buffer size,
      public: false, // Set to false to restrict minting to the tree creator/delegate
    });

    builder.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

    const merkleTreeAddress = merkleTree.publicKey;

    const explorerLink = getExplorerLink(
      "address",
      merkleTreeAddress,
      "devnet"
    );

    console.log(`Transaction submitted: ${explorerLink} '\n'`);

    console.log("Tree Address:", merkleTreeAddress);

    console.log("Created Merkle Tree Successfully ✅ ", "\n");

    fs.appendFileSync(".env", `\nMERKLE_TREE_ADDRESS=${merkleTreeAddress}`);

    return merkleTreeAddress;
  } catch (error: any) {
    console.error("\nFailed to create merkle tree:", error, "❌", "\n");
    throw error;
  }
}

createAndInitializeTree(maxDepthSizePair);
