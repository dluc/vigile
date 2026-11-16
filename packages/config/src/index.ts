export { BACKUP_EVERY_HOURS, BACKUP_KEEP_MOST, ConfigError, KEY_PREFIX, SETTINGS, checkUsers, configSchema, keyOf, staleKeys, findSetting, validateConfig, type Config, type Setting } from "./schema.js";
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
  saidNothingOf,
  setKey,
  setKeyWhileServing,
  setValue,
  UnconfirmedWrite,
  unknownEnvironment,
  unsetValue,
  writeRaw,
  type InitOptions,
  type LoadedConfig,
  type ResultingConfig,
  type Source,
} from "./file.js";
export { LiveAuth, identify, type Identity } from "./auth.js";
export { NoPlace, NotAFile, createPlainFile, kindAt, kindOf, openPlainFile, placeOf, samePlace, somethingAt, whereTo, type Place } from "./paths.js";
