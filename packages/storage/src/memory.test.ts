import { runStorageContractTests } from "./contract-tests.js";
import { MemoryStorage } from "./memory.js";

runStorageContractTests("memory", () => ({ create: async () => new MemoryStorage() }));
