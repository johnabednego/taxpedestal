import { Schema, model, Document, Types } from 'mongoose'

/**
 * Atomic sequence generator for per-organisation invoice numbering.
 *
 * DESIGN DECISION: invoice numbers must be gapless and unique per org, and many
 * tax authorities require sequential numbering. The naive implementation —
 * count documents, add one — produces duplicates the moment two invoices are
 * created concurrently, and that is a compliance defect, not just a bug.
 *
 * findOneAndUpdate with $inc and upsert is a single atomic operation at the
 * document level, so the sequence is safe without a transaction.
 */
export interface ICounter extends Document<string> {
  _id: string
  org: Types.ObjectId
  scope: string
  seq: number
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
  scope: { type: String, required: true },
  seq: { type: Number, default: 0 },
})

export const Counter = model<ICounter>('Counter', counterSchema)

/** Returns the next value in the sequence. Never returns the same value twice. */
export async function nextSequence(org: Types.ObjectId, scope: string): Promise<number> {
  const id = `${org.toString()}:${scope}`
  const doc = await Counter.findByIdAndUpdate(
    id,
    { $inc: { seq: 1 }, $setOnInsert: { org, scope } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean()
  return doc!.seq
}
