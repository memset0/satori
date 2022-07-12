import Logger from 'reggol'
import { Adapter, Context, Session } from '@satorijs/core'

import { Cipher } from './utils'
import { Event } from './types'
import { FeishuBot } from './bot'

const logger = new Logger('feishu')

export class HttpServer extends Adapter.Server<FeishuBot> {
  private ctx: Context
  private ciphers: Record<string, Cipher> = {}

  constructor(ctx: Context) {
    super(ctx)
    this.ctx = ctx

    this._refreshCipher()
  }

  async start() {
    const { path = '/feishu' } = this.config
    this.ctx.router.post(path, (ctx) => {
      logger.debug('receive %o', ctx.request.body)

      this._refreshCipher()

      // // compare signature if encryptKey is set
      // // But not every message contains signature
      // // https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-security-verification
      // const signature = firstOrDefault(ctx.headers['X-Lark-Signature'])
      // if (encryptKey && signature) {
      //   const timestamp = firstOrDefault(ctx.headers['X-Lark-Request-Timestamp'])
      //   const nonce = firstOrDefault(ctx.headers['X-Lark-Request-Nonce'])
      //   const body = ctx.request.rawBody
      //   const actualSignature = this.cipher.calculateSignature(timestamp, nonce, body)
      //   if (signature !== actualSignature) return (ctx.status = 403)
      // }

      // try to decrypt message first if encryptKey is set
      const body = this._tryDecryptBody(ctx.request.body)
      // respond challenge message
      // https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case
      if (body?.type === 'url_verification' && body?.challenge && typeof body.challenge === 'string') {
        ctx.response.body = { challenge: body.challenge }
        return
      }

      // Feishu requires 200 OK response to make sure event is received
      ctx.body = 'OK'
      ctx.status = 200

      // dispatch message
      this.dispatchSession(this._tryDecryptBody(ctx.request.body))
    })
  }

  async stop() {}

  async dispatchSession(body: Event): Promise<void> {
    const { header } = body
    const { app_id } = header
    const bot = this.bots.find((bot) => bot.selfId === app_id)
    const session = await this._adaptSession(bot, body)
    this.dispatch(session)
  }

  private _tryDecryptBody(body: any): any {
    this._refreshCipher()
    // try to decrypt message if encryptKey is set
    // https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
    const ciphers = Object.values(this.ciphers)
    if (ciphers.length && typeof body.encrypt === 'string') {
      for (const cipher of ciphers) {
        try {
          return JSON.parse(cipher.decrypt(body.encrypt))
        } catch {}
      }
      logger.warn('failed to decrypt message: %o', body)
    }

    if (typeof body.encrypt === 'string' && !ciphers.length) {
      logger.warn('encryptKey is not set, but received encrypted message: %o', body)
    }

    return body
  }

  private async _adaptSession(bot: FeishuBot, body: Event): Promise<Session<never, never>> {
    const payload: Partial<Session> = {
      selfId: bot.selfId,
    }
    const session = new Session(bot, payload)
    return session
  }

  private _refreshCipher(): void {
    const ciphers = Object.keys(this.ciphers)
    const bots = this.bots.map((bot) => bot.config.appId)
    if (bots.length === ciphers.length && bots.every((bot) => ciphers.includes(bot))) return

    this.ciphers = {}
    for (const bot of this.bots) {
      this.ciphers[bot.config.appId] = new Cipher(bot.config.encryptKey)
    }
  }
}

// function firstOrDefault(arg: string | string[]): string {
//   if (Array.isArray(arg)) {
//     return arg[0]
//   }
//   return arg
// }
