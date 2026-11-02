"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATA_DIR = void 0;
const path_1 = __importDefault(require("path"));
const configuredDataDir = process.env.VAC_DATA_DIR?.trim();
exports.DATA_DIR = path_1.default.resolve(configuredDataDir || path_1.default.resolve(__dirname, '..', 'data'));
