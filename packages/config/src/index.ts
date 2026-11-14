export { ConfigError, KEY_PREFIX, SETTINGS, checkUsers, configSchema, keyOf, staleKeys, findSetting, validateConfig, type Config, type Setting } from "./schema.js";
export {
  ConfigBusy,
  generateKey,
  initConfig,
  isTooOpen,
  loadConfig,
  masked,
  nameNew,
  readRaw,
  removeKey,
  removeKeyWhileServing,
  setKey,
  setKeyWhileServing,
  setValue,
  UnconfirmedWrite,
  unknownEnvironment,
  unsetValue,
  writeRaw,
  type InitOptions,
  type LoadedConfig,
  type Source,
} from "./file.js";
export { LiveAuth, identify, type Identity } from "./auth.js";
