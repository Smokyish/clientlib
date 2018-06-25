import { Event } from './Event'
import { Utils } from './Utils'
import { User } from './User'
import { Transaction } from './Transaction'
import { CurrencyNetwork } from './CurrencyNetwork'
import { Payment } from './Payment'
import {
  ExchangeOptions,
  Order,
  Orderbook,
  OrderbookOptions,
  SignedOrder,
  TLOptions,
  FeesRequest
} from './typings'

import { BigNumber } from 'bignumber.js'
import * as ethUtils from 'ethereumjs-util'
import * as ethABI from 'ethereumjs-abi'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export class Exchange {

  constructor (
    private event: Event,
    private user: User,
    private utils: Utils,
    private transaction: Transaction,
    private currencyNetwork: CurrencyNetwork,
    private payment: Payment
  ) {}

  public getExchanges (): Promise<any> {
    return this.utils.fetchUrl('exchange/exchanges')
  }

  public getEthWrappers (): Promise<any> {
    return this.utils.fetchUrl('exchange/eth')
  }

  public async getOrderbook (
    baseTokenAddress: string,
    quoteTokenAddress: string,
    { baseTokenDecimals, quoteTokenDecimals }: OrderbookOptions = {}
  ): Promise<Orderbook> {
    try {
      const { currencyNetwork, utils } = this
      const [ baseDecimals, quoteDecimals ] = await Promise.all([
        currencyNetwork.getDecimals(baseTokenAddress, baseTokenDecimals),
        currencyNetwork.getDecimals(quoteTokenAddress, quoteTokenDecimals)
      ])
      const params = { baseTokenAddress, quoteTokenAddress }
      const endpoint = utils.buildUrl('exchange/orderbook', params)
      const orderbook = await utils.fetchUrl<any>(endpoint)
      const { asks, bids } = orderbook
      return {
        asks: asks.map(a => ({
          ...a,
          hash: this.getOrderHashHex(a),
          makerTokenAmount: utils.formatAmount(a.makerTokenAmount, baseDecimals),
          takerTokenAmount: utils.formatAmount(a.takerTokenAmount, quoteDecimals),
          makerFee: utils.formatAmount(a.makerFee, baseDecimals),
          takerFee: utils.formatAmount(a.takerFee, quoteDecimals)
        })),
        bids: bids.map(b => ({
          ...b,
          hash: this.getOrderHashHex(b),
          makerTokenAmount: utils.formatAmount(b.makerTokenAmount, quoteDecimals),
          takerTokenAmount: utils.formatAmount(b.takerTokenAmount, baseDecimals),
          makerFee: utils.formatAmount(b.makerFee, quoteDecimals),
          takerFee: utils.formatAmount(b.takerFee, baseDecimals)
        }))
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }

  public async makeOrder (
    exchangeContractAddress: string,
    makerTokenAddress: string,
    takerTokenAddress: string,
    makerTokenValue: number | string,
    takerTokenValue: number | string,
    {
      makerTokenDecimals,
      takerTokenDecimals,
      expirationUnixTimestampSec = 2524604400
    }: ExchangeOptions = {}
  ): Promise<SignedOrder> {
    const { currencyNetwork, user, utils } = this
    try {
      const [ makerDecimals, takerDecimals ] = await Promise.all([
        currencyNetwork.getDecimals(makerTokenAddress, makerTokenDecimals),
        currencyNetwork.getDecimals(takerTokenAddress, takerTokenDecimals)
      ])
      const order = {
        exchangeContractAddress,
        expirationUnixTimestampSec: expirationUnixTimestampSec.toString(),
        feeRecipient: ZERO_ADDRESS,
        maker: user.address,
        makerFee: utils.formatAmount(0, makerDecimals),
        makerTokenAddress: ethUtils.toChecksumAddress(makerTokenAddress),
        makerTokenAmount: utils.formatAmount(makerTokenValue, makerDecimals),
        salt: Math.floor(Math.random() * 1000000000).toString(),
        taker: ZERO_ADDRESS,
        takerFee: utils.formatAmount(0, makerDecimals),
        takerTokenAddress: ethUtils.toChecksumAddress(takerTokenAddress),
        takerTokenAmount: utils.formatAmount(takerTokenValue, takerDecimals)
      }
      const orderWithFees = await this.getFees(order)
      const orderHash = this.getOrderHashHex(orderWithFees)
      return user.signMsgHash(orderHash)
        .then(({ ecSignature }) => ({...orderWithFees, ecSignature}))
        .then(signedOrder => this.postRequest('exchange/order', {
          ...signedOrder,
          makerFee: orderWithFees.makerFee.raw.toString(),
          takerFee: orderWithFees.takerFee.raw.toString(),
          makerTokenAmount: orderWithFees.makerTokenAmount.raw.toString(),
          takerTokenAmount: orderWithFees.takerTokenAmount.raw.toString()
        }).then(() => ({
          ...signedOrder,
          hash: orderHash
        }))
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  public async prepTakeOrder (
    signedOrder: SignedOrder,
    fillTakerTokenValue: number | string,
    {
      gasLimit,
      gasPrice,
      makerTokenDecimals,
      takerTokenDecimals
    }: ExchangeOptions = {}
  ): Promise<any> {
    const {
      exchangeContractAddress,
      maker,
      makerTokenAddress,
      takerTokenAddress,
      makerTokenAmount,
      takerTokenAmount,
      ecSignature
    } = signedOrder
    const { currencyNetwork, payment, transaction, user, utils } = this

    try {
      const [ makerDecimals, takerDecimals, orderWithFees ] = await Promise.all([
        currencyNetwork.getDecimals(makerTokenAddress, makerTokenDecimals),
        currencyNetwork.getDecimals(takerTokenAddress, takerTokenDecimals),
        this.getFees(signedOrder)
      ])
      const [ makerPathObj, takerPathObj ] = await Promise.all([
        this.getPathObj(
          makerTokenAddress,
          maker,
          user.address,
          this.getPartialAmount(fillTakerTokenValue, takerTokenAmount.value, makerTokenAmount.value),
          { decimals: makerDecimals }
        ),
        this.getPathObj(
          takerTokenAddress,
          user.address,
          maker,
          fillTakerTokenValue,
          { decimals: takerDecimals }
        )
      ])
      const orderAddresses = this.getOrderAddresses(orderWithFees)
      const orderValues = this.getOrderValues(orderWithFees)

      if ((makerPathObj.path.length === 0 && !makerPathObj.isNoNetwork) ||
          (takerPathObj.path.length === 0 && !takerPathObj.isNoNetwork)) {
        return Promise.reject('Could not find a path with enough capacity')
      }
      const { rawTx, ethFees } = await transaction.prepFuncTx(
        user.address,
        exchangeContractAddress,
        'Exchange',
        'fillOrderTrustlines',
        [
          orderAddresses,
          orderValues,
          utils.calcRaw(fillTakerTokenValue, takerDecimals),
          makerPathObj.path.length === 1 ? makerPathObj.path : makerPathObj.path.slice(1),
          takerPathObj.path.length === 1 ? takerPathObj.path : takerPathObj.path.slice(1),
          ecSignature.v,
          ecSignature.r,
          ecSignature.s
        ], {
          gasPrice,
          gasLimit: (takerPathObj.estimatedGas + makerPathObj.estimatedGas) * 1.5
        }
      )
      return {
        rawTx,
        ethFees,
        makerMaxFees: makerPathObj.maxFees,
        makerPath: makerPathObj.path,
        takerMaxFees: takerPathObj.maxFees,
        takerPath: takerPathObj.path
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }

  public async cancelOrder (
    signedOrder: SignedOrder,
    cancelTakerTokenValue: number | string,
    {
      gasLimit,
      gasPrice,
      makerTokenDecimals,
      takerTokenDecimals
    }: ExchangeOptions = {}): Promise<any> {
    const {
      exchangeContractAddress,
      makerTokenAddress,
      takerTokenAddress,
      ecSignature
    } = signedOrder
    const { currencyNetwork, transaction, user, utils } = this

    try {
      const [ takerDecimals, orderWithFees ] = await Promise.all([
        currencyNetwork.getDecimals(takerTokenAddress, takerTokenDecimals),
        this.getFees(signedOrder)
      ])
      const orderAddresses = this.getOrderAddresses(orderWithFees)
      const orderValues = this.getOrderValues(orderWithFees)

      const { rawTx, ethFees } = await transaction.prepFuncTx(
        user.address,
        exchangeContractAddress,
        'Exchange',
        'fillOrderTrustlines',
        [
          orderAddresses,
          orderValues,
          utils.calcRaw(cancelTakerTokenValue, takerDecimals),
          ecSignature.v,
          ecSignature.r,
          ecSignature.s
        ], {
          gasPrice,
          gasLimit
        }
      )
      return {
        rawTx,
        ethFees
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }

  public async confirm (rawTx: string): Promise<any> {
    const signedTx = await this.user.signTx(rawTx)
    return this.transaction.relayTx(signedTx)
  }

  private async getPathObj (
    tokenAddress: string,
    from: string,
    to: string,
    value: number | string,
    { decimals }: TLOptions
  ): Promise<any> {
    const { currencyNetwork, payment } = this
    return await currencyNetwork.isNetwork(tokenAddress)
      ? await payment.getPath(
          tokenAddress,
          from,
          to,
          value,
          { decimals }
        )
      : {
        path: [],
        maxFees: 0,
        estimatedGas: 40000,
        isNoNetwork: true
      }
  }

  private getOrderAddresses ({
    maker,
    makerTokenAddress,
    takerTokenAddress,
    feeRecipient
  }: Order): Array<string> {
    return [
      maker,
      ZERO_ADDRESS,
      makerTokenAddress,
      takerTokenAddress,
      feeRecipient
    ]
  }

  private getOrderValues ({
    makerTokenAmount,
    takerTokenAmount,
    makerFee,
    takerFee,
    expirationUnixTimestampSec,
    salt
  }: Order): Array<number> {
    return [
      this.toInt(makerTokenAmount.raw),
      this.toInt(takerTokenAmount.raw),
      0, // NOTE fees disabled
      0, // NOTE fees disabled
      this.toInt(expirationUnixTimestampSec),
      this.toInt(salt)
    ]
  }

  private toInt (int: number | string): number {
    return typeof int === 'string' ? parseInt(int, 10) : int
  }

  private getPartialAmount (
    numerator: number | string,
    denominator: number | string,
    target: number | string
  ): number {
    const bnNumerator = new BigNumber(numerator)
    const bnDenominator = new BigNumber(denominator)
    const bnTarget = new BigNumber(target)
    return bnNumerator.times(bnTarget).dividedBy(bnDenominator).toNumber()
  }

  private getFees (order: Order): Promise<any> {
    const {
      exchangeContractAddress,
      expirationUnixTimestampSec,
      maker,
      makerTokenAddress,
      makerTokenAmount,
      salt,
      takerTokenAddress,
      takerTokenAmount
    } = order
    // const convertedRequest = this.convertFieldsToBigNumber(request, [
    //   'expirationUnixTimestampSec', 'makerTokenAmount', 'salt', 'takerTokenAmount'
    // ])
    // NOTE fees disabled
    // return this.postRequest('/exchange/fees', convertedRequest)
    return Promise.resolve({
      ...order,
      feeRecipient: ZERO_ADDRESS,
      makerFee: this.utils.formatAmount(0, 2),
      takerFee: this.utils.formatAmount(0, 2)
    })
  }

  private postRequest (path: string, payload: any): Promise<any> {
    return this.utils.fetchUrl(path, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    })
  }

  private convertFieldsToBigNumber (obj: any, fields: string[]): any {
    fields.forEach(key => {
      if (obj[key]) {
        obj[key] = new BigNumber(obj[key]).toString()
      }
    })
    return obj
  }

  private getOrderHashHex (order: any): string {
    const orderParts = [
      {
        value: order.exchangeContractAddress,
        type: 'address'
      },
      {
        value: order.maker,
        type: 'address'
      },
      {
        value: order.taker,
        type: 'address'
      },
      {
        value: order.makerTokenAddress,
        type: 'address'
      },
      {
        value: order.takerTokenAddress,
        type: 'address'
      },
      {
        value: order.feeRecipient,
        type: 'address'
      },
      {
        value: new BigNumber(order.makerTokenAmount.raw, 10).toNumber(),
        type: 'uint256'
      },
      {
        value: new BigNumber(order.takerTokenAmount.raw, 10).toNumber(),
        type: 'uint256'
      },
      {
        value: new BigNumber(order.makerFee.raw, 10).toNumber(),
        type: 'uint256'
      },
      {
        value: new BigNumber(order.takerFee.raw, 10).toNumber(),
        type: 'uint256'
      },
      {
        value: new BigNumber(order.expirationUnixTimestampSec, 10).toNumber(),
        type: 'uint256'
      },
      {
        value: new BigNumber(order.salt, 10).toNumber(),
        type: 'uint256'
      }
    ]
    const types = orderParts.map(part => part.type)
    const values = orderParts.map(part => part.value)
    const hashBuff = ethABI.soliditySHA3(types, values)
    return ethUtils.bufferToHex(hashBuff)
  }
}
