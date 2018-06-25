import { TLNetworkConfig } from './typings'
import { TLNetwork } from './TLNetwork'

/**
 * The Configuration class contains all configurable variables of the TLNetwork instance.
 */
export class Configuration {
  /**
   *  Base URL of the relay REST API endpoint
   */
  public apiUrl: string
  /**
   * Base URL of the relay WebSocket API endpoint
   */
  public wsApiUrl: string

  /**
   * Contructs a Configuration instance that is used for interacting with a relay server.
   * @param config Configuration object. See type `TLNetworkConfig` for more information.
   */
  constructor (config: TLNetworkConfig = {}) {
    const {
      protocol = 'http',
      host = 'localhost',
      port = '',
      path = '',
      wsProtocol = 'ws'
    } = config
    this.apiUrl = this._buildApiUrl(protocol, host, port, path)
    this.wsApiUrl = this._buildApiUrl(wsProtocol, host, port, path)
  }

  /**
   * Returns URL by concatenating protocol, host, port and path.
   * @param protocol relay api endpoint protocol
   * @param host relay api host address
   * @param port relay api port
   * @param path relay api base endpoint
   */
  private _buildApiUrl (
    protocol: string,
    host: string,
    port: number | string,
    path: string
  ): string {
    return `${protocol}://${host}${port === '' ? '' : `:${port}`}/${path}`
  }
}
