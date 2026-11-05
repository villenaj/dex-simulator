import dotenv from "dotenv";

dotenv.config();

// "mongo" / "mariadb" 는 docker-compose.infra.yml 의 서비스 이름 (도커 네트워크 내부에서만 해석됨)
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "mongo", "mariadb"]);

const num = (key: string, fallback: number): number => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && String(process.env[key] ?? "").trim() !== "" ? parsed : fallback;
};

const str = (key: string, fallback: string): string => {
  const value = String(process.env[key] ?? "").trim();
  return value.length > 0 ? value : fallback;
};

const hostOf = (uri: string): string => {
  const withoutScheme = uri.replace(/^mongodb:\/\//i, "").trim();
  const withoutAuth = withoutScheme.includes("@") ? withoutScheme.split("@")[1] : withoutScheme;
  const hostPort = withoutAuth.split("/")[0];
  if (hostPort.startsWith("[")) {
    return hostPort.slice(1, hostPort.indexOf("]")).toLowerCase();
  }
  return hostPort.split(":")[0].toLowerCase();
};

export const config = {
  chain: {
    rpcUrl: str("SIM_RPC_URL", "ws://192.168.254.200:9977"),
    // system.chain() 이 이 이름과 다르면 서명/전송하지 않습니다. (메인넷 보호)
    expectedName: str("SIM_EXPECTED_CHAIN", "Local Testnet"),
    // 시뮬레이터 지갑에 XON / USDT 를 보내 주는 계정 (개발 체인의 //Alice)
    funderUri: str("SIM_FUNDER_SURI", "//Alice"),
    // 지갑 i 의 키: `${walletUri}//${i}`
    walletUri: str("SIM_WALLET_SURI", "//XodeSim"),
    quoteAssetId: num("SIM_QUOTE_ASSET_ID", 1984),
    slippageBps: num("SIM_SLIPPAGE_BPS", 100),
    finalizeTimeoutMs: num("SIM_FINALIZE_TIMEOUT_MS", 180_000),
  },
  funding: {
    // 지갑 잔고가 목표의 절반 아래로 내려가면 목표치까지 다시 채웁니다.
    baseTarget: num("SIM_FUND_XON", 200),
    quoteTarget: num("SIM_FUND_USDT", 1000),
  },
  mongo: {
    host: hostOf(str("MONGO_URI", "127.0.0.1")),
    port: num("MONGO_PORT", 27017),
    dbName: str("MONGO_DB_NAME", "xode_indexer"),
    user: str("MONGO_USER", ""),
    pass: str("MONGO_PASS", ""),
    authSource: str("MONGO_AUTH_SOURCE", "admin"),
  },
  maria: {
    host: str("MARIA_DB_HOST", "127.0.0.1"),
    port: num("MARIA_DB_PORT", 3306),
    user: str("MARIA_DB_USER", "root"),
    password: str("MARIA_DB_PASS", ""),
    database: str("MARIA_DB_NAME", "dex_db"),
  },
  pair: {
    poolId: str("SIM_POOL_ID", "0"),
    base: str("SIM_BASE", "XON"),
    quote: str("SIM_QUOTE", "USDT"),
  },
  activity: {
    tradesPerDay: num("SIM_TRADES_PER_DAY", num("SIM_TRADES_PER_DAY_END", 18)),
    walletCount: num("SIM_WALLET_COUNT", 24),
  },
  price: {
    // 지갑들이 따라가는 "적정 가격" 의 일간 변동성. 실제 체결가는 풀(AMM)이 정합니다.
    dailyVolatility: num("SIM_DAILY_VOLATILITY", 0.06),
    medianTradeUsdt: num("SIM_MEDIAN_TRADE_USDT", 35),
  },
  seed: str("SIM_SEED", ""),
};

// purge 는 예전 버전이 DB 에 직접 넣은 가짜 데이터를 지우므로 로컬 DB 에서만 허용합니다.
export const assertLocalTargets = () => {
  const offenders: string[] = [];
  if (!LOCAL_HOSTS.has(config.mongo.host)) offenders.push(`MONGO_URI=${config.mongo.host}`);
  if (!LOCAL_HOSTS.has(config.maria.host.toLowerCase())) offenders.push(`MARIA_DB_HOST=${config.maria.host}`);

  if (offenders.length > 0) {
    throw new Error(
      `Refusing to run: purge only touches localhost databases. Offending settings: ${offenders.join(", ")}`,
    );
  }
};

export const pairKey = () => `pool:${config.pair.poolId}`;
