import dotenv from "dotenv";
import {
  mintToCollectionV1,
  LeafSchema,
  parseLeafFromMintV1Transaction,
} from "@metaplex-foundation/mpl-bubblegum";
import { base58, PublicKey } from "@metaplex-foundation/umi";
import BN from "bn.js";
import { getOrCreateCollectionNFT, createNftMetadata } from "./utils";
import { initializeUmi } from ".";

dotenv.config();

const umi = await initializeUmi();

const collectionNft = await getOrCreateCollectionNFT(umi);

export async function getLeafAssetId(treeAddress: PublicKey, index: BN) {
  try {
    const mintAddress = collectionNft.mint;

    const compressedNFTMetadata = createNftMetadata(
      umi.identity.publicKey,
      index.toNumber(),
      mintAddress
    );

    const { signature } = await mintToCollectionV1(umi, {
      leafOwner: umi.identity.publicKey,
      merkleTree: treeAddress,
      collectionMint: mintAddress,
      metadata: compressedNFTMetadata,
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

    const base64Sig = base58.deserialize(signature);

    console.log(base64Sig);

    const leaf: LeafSchema = await parseLeafFromMintV1Transaction(
      umi,
      signature
    );
    // const assetId = findLeafAssetIdPda(umi, { merkleTree, leafIndex: leaf.nonce });
    // return assetId
    return leaf.id;
  } catch (error: any) {
    console.error(
      `An Error occurred while trying to get the leaf Asset ID: error: ${error}`
    );
    throw error;
  }
}
