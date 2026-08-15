import request from 'supertest'
import { createApp } from '../../src/create-app'
const app = createApp()

describe('public tax preview', () => {
  it('computes Ghana VAT + levies without authentication', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'GH',
      customer: { country: 'GH', isBusiness: true, taxId: 'C001', taxRegistered: true },
      currency: 'GHS',
      lines: [{ description: 'Design', quantityMilli: 1000, unitAmountMinor: 100_000 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.taxMinor).toBe(20_000)
    expect(res.body.taxComponents.map((c: {code:string}) => c.code)).toEqual(['GH_VAT','GH_NHIL','GH_GETFUND'])
  })

  it('reverse-charges an intra-EU B2B supply to zero', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'DE',
      customer: { country: 'FR', isBusiness: true, taxId: 'FR123', taxRegistered: true },
      currency: 'EUR',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitAmountMinor: 100_000 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.taxMinor).toBe(0)
    expect(res.body.taxNotes.join(' ')).toMatch(/Article 196/)
  })

  it('applies the DESTINATION rate to an EU B2C digital service', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'DE',
      customer: { country: 'HU', isBusiness: false, taxRegistered: false },
      currency: 'EUR',
      lines: [{ description: 'Template', quantityMilli: 1000, unitAmountMinor: 100_000, supplyType: 'digital_services' }],
    })
    expect(res.status).toBe(200)
    // Hungary 27%, not Germany 19%.
    expect(res.body.taxMinor).toBe(27_000)
  })

  it('still requires auth on the real invoice routes', async () => {
    const res = await request(app).get('/api/v1/invoices')
    expect(res.status).toBe(401)
  })
})

describe('public preview, sub-national tax', () => {
  it('splits CGST and SGST for an intra-state Indian supply', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'IN',
      supplierRegion: 'MH',
      customer: { country: 'IN', region: 'MH', isBusiness: true, taxRegistered: true },
      currency: 'INR',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitAmountMinor: 100_000 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.taxComponents.map((c: { code: string }) => c.code)).toEqual([
      'IN_CGST',
      'IN_SGST',
    ])
  })

  it('charges a single IGST line for an inter-state Indian supply', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'IN',
      supplierRegion: 'MH',
      customer: { country: 'IN', region: 'KA', isBusiness: true, taxRegistered: true },
      currency: 'INR',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitAmountMinor: 100_000 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.taxComponents.map((c: { code: string }) => c.code)).toEqual(['IN_IGST'])
    expect(res.body.taxMinor).toBe(18_000)
  })

  it('applies the destination state rate for US goods', async () => {
    const res = await request(app).post('/api/v1/invoices/preview-public').send({
      supplierCountry: 'US',
      supplierRegion: 'CA',
      customer: { country: 'US', region: 'TX', isBusiness: true, taxRegistered: true },
      currency: 'USD',
      lines: [
        { description: 'Hardware', quantityMilli: 1000, unitAmountMinor: 100_000, supplyType: 'goods' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.taxMinor).toBe(6_250)
  })
})
