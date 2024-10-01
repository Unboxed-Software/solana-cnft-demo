import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";
import {
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  UseMethod,
} from "@metaplex-foundation/mpl-bubblegum";
import { PublicKey as UmiPublicKey } from "@metaplex-foundation/umi-public-keys";
import { some } from "@metaplex-foundation/umi-options";
import {
  createNft,
  fetchMetadataFromSeeds,
  findMasterEditionPda,
  findMetadataPda,
} from "@metaplex-foundation/mpl-token-metadata";
import { uris } from "./uri";
import {
  getKeypairFromEnvironment,
  addKeypairToEnvFile,
  airdropIfRequired,
  getExplorerLink,
} from "@solana-developers/helpers";
import {
  generateSigner,
  percentAmount,
  publicKey,
  Umi,
} from "@metaplex-foundation/umi";

export async function getOrCreateKeypair(walletName: string): Promise<Keypair> {
  let keypair: Keypair;

  // Try to load the keypair from the environment variable
  try {
    keypair = getKeypairFromEnvironment(walletName); // throws error if keypair is invalid or does not exist
    console.log(`${walletName} PublicKey: ${keypair.publicKey.toBase58()}`);
    console.log("Retrieved wallet from .env file successfully! ✅");

  } catch (error) {
    // If keypair doesn't exist in .env, generate a new keypair and store it
    console.log(`Writing ${walletName} keypair to .env file...`);

    // Generate a new keypair
    keypair = Keypair.generate();

    // Save keypair to .env file using helper function
    await addKeypairToEnvFile(keypair, walletName);

    console.log(`${walletName} PublicKey: ${keypair.publicKey.toBase58()}`);
     console.log("Created wallet successfully! ✅");
  }

  return keypair;
}

export async function airdropSolIfNeeded(publicKey: PublicKey) {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  try {
    const newBalance = await airdropIfRequired(
      connection,
      publicKey,
      5 * LAMPORTS_PER_SOL, // Airdrop 5 SOL if needed
      1.5 * LAMPORTS_PER_SOL // Only airdrop if the balance is below 1.5 SOL
    );

    console.log("New balance is", newBalance / LAMPORTS_PER_SOL);
  } catch (error) {
    console.log("Airdrop Unsuccessful, likely rate-limited. Try again later.");
  }
}

export function createNftMetadata(creator: UmiPublicKey, index: number, collectionMint: UmiPublicKey) {
  if (index > uris.length) {
    throw new Error("Index is out of range");
  }

  const uri = uris[index];

  // Compressed NFT Metadata
  const compressedNFTMetadata: MetadataArgs = {
    name: "Collection NFT",
    symbol: "cNFT",
    uri: uri,
    creators: [{ address: creator, verified: false, share: 100 }],
    editionNonce: some(0),
    uses: some({
      useMethod: UseMethod.Single,
      remaining: BigInt(5), // 5 uses remaining
      total: BigInt(5), // Total of 5 uses originally
    }),
    collection: some({
      key: collectionMint,
      verified: false,
    }),
    primarySaleHappened: false,
    sellerFeeBasisPoints: 10,
    isMutable: true,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: some(TokenStandard.NonFungible),
  };

  return compressedNFTMetadata;
}

export type CollectionDetails = {
  mint: UmiPublicKey;
  metadata: UmiPublicKey;
  masterEditionAccount: UmiPublicKey;
};


export async function getOrCreateCollectionNFT(umi: Umi) {
  const envCollectionNftAddress = process.env["COLLECTION_NFT"];
  const collectionMint = generateSigner(umi);

  // Helper function to log explorer links
  const logExplorerLinks = (
    mint: UmiPublicKey,
    metadata: UmiPublicKey,
    masterEdition: UmiPublicKey
  ) => {
    console.log(
      "Mint Address:",
      getExplorerLink("address", mint, "devnet"),
      '\n'
    );
    console.log(
      "Metadata Address:",
      getExplorerLink("address", metadata, "devnet"), '\n'
    );
    console.log(
      "Master Edition Account:",
      getExplorerLink("address", masterEdition, "devnet"),
      '\n'
    );
  };

  // Helper function to fetch metadata and master edition addresses for a given mint
  const fetchCollectionAddresses = async (
    collectionNftAddress: UmiPublicKey
  ) => {
    const metadataAddress = findMetadataPda(umi, {
      mint: collectionNftAddress,
    })[0];
    const masterEditionAddress = findMasterEditionPda(umi, {
      mint: collectionNftAddress,
    })[0];
    return { metadataAddress, masterEditionAddress };
  };

  // If collection NFT address exists in .env, fetch its details and return
  if (envCollectionNftAddress) {
    const collectionNftAddress = publicKey(envCollectionNftAddress);
    const collectionNft = await fetchMetadataFromSeeds(umi, {
      mint: collectionNftAddress,
    });
    const { metadataAddress, masterEditionAddress } =
      await fetchCollectionAddresses(collectionNftAddress);

    logExplorerLinks(collectionNft.mint, metadataAddress, masterEditionAddress);

    return {
      mint: collectionNft.mint,
      metadata: metadataAddress,
      masterEditionAccount: masterEditionAddress,
    };
  }

  // If no collection NFT exists, create a new one
  const randomUri = uris[Math.floor(Math.random() * uris.length)];

  await createNft(umi, {
    mint: collectionMint,
    name: "Collection NFT",
    uri: randomUri,
    authority: umi.identity,
    updateAuthority: umi.identity.publicKey,
    sellerFeeBasisPoints: percentAmount(10),
    symbol: "cNFT",
    isMutable: true,
    isCollection: true,
  }).sendAndConfirm(umi, { send: { commitment: "finalized" } });

  const collectionNftAddress = collectionMint.publicKey;
  const collectionNft = await fetchMetadataFromSeeds(umi, {
    mint: collectionNftAddress,
  });
  const { metadataAddress, masterEditionAddress } =
    await fetchCollectionAddresses(collectionNftAddress);

  // Save the new collection NFT to .env
  fs.appendFileSync(".env", `\nCOLLECTION_NFT=${collectionNft.mint}`);

  logExplorerLinks(collectionNft.mint, metadataAddress, masterEditionAddress);
  // wrap in try catch , add success message 
  return {
    mint: collectionNft.mint,
    metadata: metadataAddress,
    masterEditionAccount: masterEditionAddress,
  };
}

