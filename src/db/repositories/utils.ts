import { NormalizationMode } from "../../types";

export function getNormalizationUnit(normalization: NormalizationMode | undefined) {
    if (!normalization || normalization === 'total') {
      return 'RON';
    }
    if (normalization === 'total_euro') {
      return 'EUR';
    }
    if (normalization === 'per_capita') {
      return 'RON/capita';
    }
    if (normalization === 'per_capita_euro') {
      return 'EUR/capita';
    }
    throw new Error(`Unknown normalization mode: ${normalization}`);
  }