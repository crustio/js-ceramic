import * as uint8arrays from 'uint8arrays'
import { decode } from 'multiformats/hashes/digest'
import * as providers from '@ethersproject/providers'
import lru from 'lru_map'
import { AnchorProof, AnchorValidator, DiagnosticsLogger } from '@ceramicnetwork/common'
import { Block, TransactionResponse } from '@ethersproject/providers'
import { base16 } from 'multiformats/bases/base16'

/**
 * Ethereum network configuration
 */
interface EthNetwork {
  network: string
  chain: string
  chainId: number
  networkId: number
  type: string
}

/**
 * Maps some of Ethereum chain IDs to network configuration
 */
const ETH_CHAIN_ID_MAPPINGS: Record<string, EthNetwork> = {
  'eip155:1': { network: 'mainnet', chain: 'ETH', chainId: 1, networkId: 1, type: 'Production' },
  'eip155:3': { network: 'ropsten', chain: 'ETH', chainId: 3, networkId: 3, type: 'Test' },
  'eip155:4': { network: 'rinkeby', chain: 'ETH', chainId: 4, networkId: 4, type: 'Test' },
}

const BASE_CHAIN_ID = 'eip155'
const MAX_PROVIDERS_COUNT = 100
const TRANSACTION_CACHE_SIZE = 50
const BLOCK_CACHE_SIZE = 50

/**
 * Ethereum anchor service that stores root CIDs on Ethereum blockchain
 */
export class EthereumAnchorValidator implements AnchorValidator {
  private _chainId: string | null
  private readonly providersCache: lru.LRUMap<string, providers.BaseProvider>
  private readonly _transactionCache: lru.LRUMap<string, TransactionResponse>
  private readonly _blockCache: lru.LRUMap<string, Block>
  private readonly _logger: DiagnosticsLogger

  /**
   * @param ethereumRpcEndpoint
   * @param logger
   */
  constructor(readonly ethereumRpcEndpoint: string, logger: DiagnosticsLogger) {
    this.providersCache = new lru.LRUMap(MAX_PROVIDERS_COUNT)
    this._transactionCache = new lru.LRUMap(TRANSACTION_CACHE_SIZE)
    this._blockCache = new lru.LRUMap(BLOCK_CACHE_SIZE)
    this._logger = logger
  }

  /**
   * @param chainId - Chain ID for ethereum chain that we need to validate, or null. If null, then
   *   the `ethereumRpcEndpoint` needs to be chain-id specific so there's no ambiguity as to
   *   which chain we are operating with.
   */
  async init(chainId: string | null): Promise<void> {
    if (!chainId) {
      return
    }

    // Confirm that we have an eth provider that works for the same chain that the anchor service supports (if given)
    const provider = this._getEthProvider(chainId)
    const provider_chain_idnum = (await provider.getNetwork()).chainId
    const provider_chain = BASE_CHAIN_ID + ':' + provider_chain_idnum
    if (chainId != provider_chain) {
      throw new Error(
        `Configured eth provider is for chainId ${provider_chain}, but our anchor service uses chain ${this._chainId}`
      )
    }
    this._chainId = chainId
  }

  /**
   * Given a chainId and a transaction hash, loads information from ethereum about the transaction
   * and block the transaction was included in.
   * Testing has shown that when no ethereumRpcEndpoint has been provided and we are therefore using
   * the ethersproject's defaultProvider, we sometimes get back null for the transaction or block,
   * so this function also includes some extra error handling and throws exceptions with a warning
   * to use an actual ethereum rpc endpoint if the above behavior is seen.
   * @param chainId
   * @param txHash
   * @private
   */
  private async _getTransactionAndBlockInfo(
    chainId: string,
    txHash: string
  ): Promise<[TransactionResponse, Block]> {
    try {
      // determine network based on a chain ID
      const provider: providers.BaseProvider = this._getEthProvider(chainId)
      let transaction = this._transactionCache.get(txHash)

      if (!transaction) {
        transaction = await provider.getTransaction(txHash)
        this._transactionCache.set(txHash, transaction)
      }

      if (!transaction) {
        if (!this.ethereumRpcEndpoint) {
          throw new Error(
            `Failed to load transaction data for transaction ${txHash}. Try providing an ethereum rpc endpoint`
          )
        } else {
          throw new Error(`Failed to load transaction data for transaction ${txHash}`)
        }
      }

      let block = this._blockCache.get(transaction.blockHash)
      if (!block) {
        block = await provider.getBlock(transaction.blockHash)
        this._blockCache.set(transaction.blockHash, block)
      }
      if (!block) {
        if (!this.ethereumRpcEndpoint) {
          throw new Error(
            `Failed to load transaction data for block with block number ${transaction.blockNumber} and block hash ${transaction.blockHash}. Try providing an ethereum rpc endpoint`
          )
        } else {
          throw new Error(
            `Failed to load transaction data for block with block number ${transaction.blockNumber} and block hash ${transaction.blockHash}`
          )
        }
      }
      return [transaction, block]
    } catch (e) {
      this._logger.err(
        `Error loading transaction info for transaction ${txHash} from Ethereum: ${e}`
      )
      throw e
    }
  }

  /**
   * Validate anchor proof on the chain
   * @param anchorProof - Anchor proof instance
   */
  async validateChainInclusion(anchorProof: AnchorProof): Promise<void> {
    const decoded = decode(anchorProof.txHash.multihash.bytes)
    const txHash = '0x' + uint8arrays.toString(decoded.digest, 'base16')

    const [transaction, block] = await this._getTransactionAndBlockInfo(anchorProof.chainId, txHash)
    const txValueHexNumber = parseInt(transaction.data, 16)
    const rootValueHexNumber = parseInt('0x' + anchorProof.root.toString(base16), 16)

    if (txValueHexNumber !== rootValueHexNumber) {
      throw new Error(`The root CID ${anchorProof.root.toString()} is not in the transaction`)
    }

    if (anchorProof.blockNumber !== transaction.blockNumber) {
      throw new Error(
        `Block numbers are not the same. AnchorProof blockNumber: ${anchorProof.blockNumber}, eth txn blockNumber: ${transaction.blockNumber}`
      )
    }

    if (anchorProof.blockTimestamp !== block.timestamp) {
      throw new Error(
        `Block timestamps are not the same. AnchorProof blockTimestamp: ${anchorProof.blockTimestamp}, eth txn blockTimestamp: ${block.timestamp}`
      )
    }
  }

  /**
   * Gets Ethereum provider based on chain ID
   * @param chain - CAIP-2 Chain ID
   * @private
   */
  private _getEthProvider(chain: string): providers.BaseProvider {
    const fromCache = this.providersCache.get(chain)
    if (fromCache) return fromCache

    if (!chain.startsWith('eip155')) {
      throw new Error(`Unsupported chainId '${chain}' - must be eip155 namespace`)
    }

    if (this._chainId && this._chainId != chain) {
      throw new Error(
        `Unsupported chainId '${chain}'. Configured anchor service only supports '${this._chainId}'`
      )
    }

    if (this.ethereumRpcEndpoint) {
      const provider = new providers.JsonRpcProvider(this.ethereumRpcEndpoint)
      this.providersCache.set(chain, provider)
      return provider
    }

    const ethNetwork: EthNetwork = ETH_CHAIN_ID_MAPPINGS[chain]
    if (ethNetwork == null) {
      throw new Error(`No ethereum provider available for chainId ${chain}`)
    }

    const provider = providers.getDefaultProvider(ethNetwork.network)
    this.providersCache.set(chain, provider)
    return provider
  }
}
