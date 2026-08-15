// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const globalThis: any

export default async function globalTeardown(): Promise<void> {
  const replSet = globalThis.__MONGO_REPLSET__
  if (replSet) await replSet.stop()
}
