import dotenv from "dotenv";
import { mintToCollectionV1 } from "@metaplex-foundation/mpl-bubblegum";
import { CollectionDetails } from "@metaplex-foundation/mpl-token-metadata";
import { base58, Keypair, publicKey, PublicKey } from "@metaplex-foundation/umi";
import { getExplorerLink } from "@solana-developers/helpers";
import { createNftMetadata, getOrCreateCollectionNFT } from "./utils";
import { initializeUmi } from ".";
import { maxDepthSizePair } from "./create-and-initialize-tree";

dotenv.config();

const umi = await initializeUmi();

const collectionNft = await getOrCreateCollectionNFT(umi);

export async function mintCompressedNftToCollection(
  payer: PublicKey,
  collectionDetails: CollectionDetails,
  amount: number
) {
  if (!process.env.MERKLE_TREE_ADDRESS) {
    throw new Error("No MERKLE_TREE_ADDRESS found");
  }
  const treeAddress = process.env["MERKLE_TREE_ADDRESS"];

  const mintAddress = collectionDetails.mint;

  for (let i = 0; i < amount; i++) {
    // Compressed NFT Metadata
    const compressedNFTMetadata = createNftMetadata(
      payer,
      i,
      mintAddress
    );

    const { signature } = await mintToCollectionV1(umi, {
      leafOwner: payer,
      merkleTree: publicKey(treeAddress),
      collectionMint: mintAddress,
      metadata: compressedNFTMetadata,
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

    const transactionSignature = base58.deserialize(signature);

    try {
      const explorerLink = getExplorerLink(
        "transaction",
        transactionSignature[0],
        "devnet"
      );

      console.log(`Transaction submitted: ${explorerLink} '\n'`);

      console.log("Address:", transactionSignature[0]);
    } catch (err) {
      console.error("\nFailed to mint compressed NFT: '\n'", err);

      throw err;
    }
  }
}

mintCompressedNftToCollection(
  umi.identity.publicKey,
  collectionNft,
  2 ** maxDepthSizePair.maxDepth //
);
