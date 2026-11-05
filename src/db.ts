import mariadb, { Pool } from "mariadb";
import { MongoClient, Db } from "mongodb";

import { config } from "./config";

export interface Connections {
  mongo: MongoClient;
  db: Db;
  maria: Pool;
}

export const connect = async (): Promise<Connections> => {
  const { host, port, dbName, user, pass, authSource } = config.mongo;
  const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  const query = auth ? `?authSource=${encodeURIComponent(authSource)}` : "";

  const mongo = new MongoClient(`mongodb://${auth}${host}:${port}/${dbName}${query}`, {
    serverSelectionTimeoutMS: 5000,
  });
  await mongo.connect();

  const maria = mariadb.createPool({
    ...config.maria,
    connectionLimit: 4,
  });

  return { mongo, db: mongo.db(dbName), maria };
};

export const disconnect = async (conns: Connections) => {
  await conns.mongo.close();
  await conns.maria.end();
};
