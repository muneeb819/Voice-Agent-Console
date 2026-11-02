import path from 'path';

const configuredDataDir = process.env.VAC_DATA_DIR?.trim();

export const DATA_DIR = path.resolve(
  configuredDataDir || path.resolve(__dirname, '..', 'data')
);