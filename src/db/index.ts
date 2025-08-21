import primaryPool from "./connection";
import userDataPool from "./connectionUserData";

export type DataDomain = "budget" | "userdata";

export function getPool(domain: DataDomain) {
  return domain === "userdata" ? userDataPool : primaryPool;
}

export { primaryPool, userDataPool };


