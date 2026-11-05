import fs from "fs";
import path from "path";

export const DEFAULT_STATE_FILE = path.resolve(__dirname, "..", "state", "state.json");

// 예전 버전이 MariaDB swap 테이블에 넣은 행 ID. purge 시 이 목록만 삭제합니다.
export interface LegacyState {
  swapIds: number[];
}

export const loadState = (file = DEFAULT_STATE_FILE): LegacyState | null => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as LegacyState;
};

export const clearState = (file = DEFAULT_STATE_FILE) => {
  if (fs.existsSync(file)) fs.unlinkSync(file);
};
