import { Db } from "mongodb";
import { Pool } from "mariadb";

import { pairKey } from "./config";

// 예전 버전(DB 직접 기록)이 남긴 캔들 표시. purge 시 이 값으로만 삭제합니다.
const SIM_SOURCE_TYPES = ["sim_swap", "sim_gap"];

export const countSimCandles = async (db: Db) =>
  db.collection("charts").countDocuments({ pairKey: pairKey(), lastSourceType: { $in: SIM_SOURCE_TYPES } });

export const deleteSimCandles = async (db: Db) =>
  db.collection("charts").deleteMany({ pairKey: pairKey(), lastSourceType: { $in: SIM_SOURCE_TYPES } });

export const deleteSwaps = async (maria: Pool, ids: number[]): Promise<number> => {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const result = await maria.query(`DELETE FROM swap WHERE swap_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    deleted += Number(result.affectedRows ?? 0);
  }
  return deleted;
};
