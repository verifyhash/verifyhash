// Deploys ContributionRegistry. For testnet (Amoy) use a throwaway, faucet-funded key.
// Usage: npx hardhat run scripts/deploy.js --network amoy
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set PRIVATE_KEY in .env for non-local networks.");
  }
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(bal)} (native)`);

  const Factory = await ethers.getContractFactory("ContributionRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  console.log(`ContributionRegistry deployed at: ${await registry.getAddress()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
