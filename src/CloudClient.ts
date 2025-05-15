import url from 'url'
import got, { Got } from 'got'
import {
  UserSignResponse,
  UserSizeInfoResponse,
  AccessTokenResponse,
  FamilyListResponse,
  FamilyUserSignResponse,
  ConfigurationOptions,
  ClientSession,
  RefreshTokenSession,
  TokenSession,
  CacheQuery
} from './types'
import { logger } from './log'
import { getSignature, rsaEncrypt } from './util'
import {
  WEB_URL,
  API_URL,
  AUTH_URL,
  UserAgent,
  clientSuffix,
  AppID,
  ClientType,
  ReturnURL,
  AccountType
} from './const'
import { Store, MemoryStore } from './store'
import { checkError } from './error'
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
type DnsLookupIpVersion = 'auto' | 'ipv4' | 'ipv6';

const dnsLookupIpVersion: DnsLookupIpVersion = 
  process.env.DNS_LOOKUP_IP_VERSION === 'ipv4' ? 'ipv4' :
  process.env.DNS_LOOKUP_IP_VERSION === 'ipv6' ? 'ipv6' :
  'auto';
const config = {
  clientId: '538135150693412',
  model: 'KB2000',
  version: '9.0.6'
}

interface LoginResponse {
  result: number
  msg: string
  toUrl: string
}


/**
 * @public
 */
export class CloudAuthClient {
  readonly request: Got
  private proxyUrl: string | null = null;
  private loginCache: CacheQuery | null = null;

  constructor() {
    this.request = got.extend({
      headers: {
        'User-Agent': UserAgent,
        Accept: 'application/json;charset=UTF-8',
        "Referer": WEB_URL,
      },
      timeout: {
        request: 10000  // 设置10秒超时
      },
      // 配置ipv4
      dnsLookupIpVersion: dnsLookupIpVersion,
      hooks: {
        beforeRequest: [
          async (options) => {
            if (this.proxyUrl) {
              options.agent = {
                http: new HttpProxyAgent(this.proxyUrl),
                https: new HttpsProxyAgent(this.proxyUrl)
              };
            }
          }
        ],
        afterResponse: [
          async (response, retryWithMergedOptions) => {
            logger.debug(`url: ${response.requestUrl}, response: ${response.body})}`)
            checkError(response.body.toString())
            return response
          }
        ]
      }
    })
  }

  setProxy(proxyUrl: string | null) {
    this.proxyUrl = proxyUrl;
  }

  /**
   * 获取加密参数
   * @returns
   */
  getEncrypt(): Promise<{
    data: {
      pubKey: string
      pre: string
    }
  }> {
    return this.request.post(`${AUTH_URL}/api/logbox/config/encryptConf.do`).json()
  }

  async getLoginForm(): Promise<CacheQuery> {
    const res = await this.request
      .get(`${WEB_URL}/api/portal/unifyLoginForPC.action`, {
        searchParams: {
          appId: AppID,
          clientType: ClientType,
          returnURL: ReturnURL,
          timeStamp: Date.now()
        }
      })
      .text()
    if (res) {
      const captchaToken = res.match(`'captchaToken' value='(.+?)'`)[1]
      const lt = res.match(`lt = "(.+?)"`)[1]
      const paramId = res.match(`paramId = "(.+?)"`)[1]
      const reqId = res.match(`reqId = "(.+?)"`)[1]
      return { captchaToken, lt, paramId, reqId, publicKey: '', preKey: '', rsaUserName: '', rsaPassword: ''}
    }
    return null
  }

  #builLoginForm = (appConf: CacheQuery, validateCode?: string) => {
    const data = {
      appKey: AppID,
      accountType: AccountType,
      // mailSuffix: '@189.cn',
      validateCode: validateCode,
      captchaToken: appConf.captchaToken,
      dynamicCheck: 'FALSE',
      clientType: '1',
      cb_SaveName: '3',
      isOauth2: false,
      returnUrl: ReturnURL,
      paramId: appConf.paramId,
      userName: appConf.rsaUserName,
      password: appConf.rsaPassword
    }
    return data
  }

  async getSessionForPC(param: { redirectURL?: string; accessToken?: string }) {
    const params = {
      appId: AppID,
      ...clientSuffix(),
      ...param
    }
    const res = await this.request
      .post(`${API_URL}/getSessionForPC.action`, {
        searchParams: params
      })
      .json<TokenSession>()
    return res
  }

  /**
   * 用户名密码登录
   * */
  async loginByPassword(username: string, password: string, validateCode?: string) {
    logger.debug('loginByPassword...')
    try {
      let appConf: CacheQuery;
      if (validateCode && this.loginCache) {
        appConf = this.loginCache
      }else{
        const res = await Promise.all([
          //1.获取公钥
          this.getEncrypt(),
          //2.获取登录参数
          this.getLoginForm()
        ])
        const encrypt = res[0].data
        appConf = res[1]
        appConf.publicKey = encrypt.pubKey
        appConf.preKey = encrypt.pre
        const keyData = `-----BEGIN PUBLIC KEY-----\n${encrypt.pubKey}\n-----END PUBLIC KEY-----`
        const usernameEncrypt = rsaEncrypt(keyData, username)
        const passwordEncrypt = rsaEncrypt(keyData, password)
        appConf.rsaUserName = `${encrypt.pre}${usernameEncrypt}`
        appConf.rsaPassword = `${encrypt.pre}${passwordEncrypt}`
        await this._checkValidateCode(appConf)
      }
      
      const data = this.#builLoginForm(appConf, validateCode)
      const loginRes = await this.request
        .post(`${AUTH_URL}/api/logbox/oauth2/loginSubmit.do`, {
          headers: {
            Referer: AUTH_URL,
            lt: appConf.lt,
            REQID: appConf.reqId
          },
          form: data
        })
        .json<LoginResponse>()
        if (!loginRes.toUrl) {
          throw new Error(`登录失败: ${loginRes.msg}`)
        }
      return await this.getSessionForPC({ redirectURL: loginRes.toUrl })
    } catch (e) {
      logger.error(e)
      throw e
    }finally{
      if (validateCode) {
        this.loginCache = null
      }
    }
  }

  /**
   * token登录
   */
  async loginByAccessToken(accessToken: string) {
    logger.debug('loginByAccessToken...')
    return await this.getSessionForPC({ accessToken })
  }

  /**
   * sso登录
   */
  async loginBySsoCooike(cookie: string) {
    logger.debug('loginBySsoCooike...')
    const res = await this.request.get(`${WEB_URL}/api/portal/unifyLoginForPC.action`, {
      searchParams: {
        appId: AppID,
        clientType: ClientType,
        returnURL: ReturnURL,
        timeStamp: Date.now()
      }
    })
    const redirect = await this.request(res.url, {
      headers: {
        Cookie: `SSON=${cookie}`
      }
    })
    return await this.getSessionForPC({ redirectURL: redirect.url })
  }

  /**
   * 刷新token
   */
  refreshToken(refreshToken: string): Promise<RefreshTokenSession> {
    return this.request
      .post(`${AUTH_URL}/api/oauth2/refreshToken.do`, {
        form: {
          clientId: AppID,
          refreshToken,
          grantType: 'refresh_token',
          format: 'json'
        }
      })
      .json()
  }

  /**
   * 判断是否需要验证码
   */
  async _checkValidateCode(appConf: CacheQuery) {
    // 判断是否需要验证码
    const needCaptcha = await this.request
    .post(`${AUTH_URL}/api/logbox/oauth2/needcaptcha.do`, {
      headers: {
        REQID: appConf.reqId
      },
      form: {
        appKey: AppID,
        accountType: AccountType,
        userName: appConf.rsaUserName,
      }
    })
    .text()
    if (needCaptcha === '1') {
      const imgRes = await this.request
          .get(`${AUTH_URL}/api/logbox/oauth2/picCaptcha.do`, {
            searchParams: {
              token: appConf.captchaToken,
              REQID: appConf.reqId,
              rnd: Date.now()
            },
             responseType: 'buffer'
          })
        if (imgRes.body.length > 20) {
          const base64Image = imgRes.body.toString('base64');
          this.loginCache = appConf
          throw {
            code: 'NEED_CAPTCHA',
            message: '需要验证码',
            data: {
              image: `data:image/png;base64,${base64Image}`
            }
          }
        }
        throw {
          code: 'GET_CAPTCHA_FAIL',
          message: '获取验证码失败'
        }
    }
    return false;
  }
}

/**
 * 天翼网盘客户端
 * @public
 */
export class CloudClient {
  username: string
  password: string
  ssonCookie: string
  tokenStore: Store
  readonly request: Got
  readonly authClient: CloudAuthClient
  readonly session: ClientSession
  #sessionKeyPromise: Promise<TokenSession>
  #accessTokenPromise: Promise<AccessTokenResponse>
  private proxyUrl: string | null = null;
  private forceRefresh: boolean = false

  constructor(_options: ConfigurationOptions) {
    this.#valid(_options)
    this.username = _options.username
    this.password = _options.password
    this.ssonCookie = _options.ssonCookie
    this.tokenStore = _options.token || new MemoryStore()
    this.authClient = new CloudAuthClient()
    // 如果有代理
    if(_options.proxyUrl) {
      this.setProxy(_options.proxyUrl);
    }
    this.session = {
      accessToken: '',
      sessionKey: ''
    }
    this.request = got.extend({
      retry: {
        limit: 5
      },
      timeout: {
        request: 10000  // 设置10秒超时
      },
      headers: {
        'User-Agent': UserAgent,
        Referer: `${WEB_URL}/web/main/`,
        Accept: 'application/json;charset=UTF-8'
      },
      dnsLookupIpVersion: dnsLookupIpVersion,
      hooks: {
        beforeRequest: [
          async (options) => {
            if (this.proxyUrl) {
              options.agent = {
                http: new HttpProxyAgent(this.proxyUrl),
                https: new HttpsProxyAgent(this.proxyUrl)
              };
            }
            if (options.url.href.includes(API_URL)) {
              const accessToken = await this.getAccessToken()
              const { query } = url.parse(options.url.toString(), true)
              const time = String(Date.now())
              const signature = getSignature({
                ...(options.method === 'GET' ? query : options.json),
                Timestamp: time,
                AccessToken: accessToken
              })
              options.headers['Sign-Type'] = '1'
              options.headers['Signature'] = signature
              options.headers['Timestamp'] = time
              options.headers['Accesstoken'] = accessToken
            } else if (options.url.href.includes(WEB_URL)) {
              const urlObj = new URL(options.url)
              if (options.url.href.includes('/open')) {
                const time = String(Date.now())
                const appkey = '600100422'
                const signature = getSignature({
                  ...(options.method === 'GET' ? urlObj.searchParams : options.json),
                  Timestamp: time,
                  AppKey: appkey
                })
                options.headers['Sign-Type'] = '1'
                options.headers['Signature'] = signature
                options.headers['Timestamp'] = time
                options.headers['AppKey'] = appkey
              }
              const sessionKey = await this.getSessionKey()
              urlObj.searchParams.set('sessionKey', sessionKey)
              options.url = urlObj
            }
          }
        ],
        afterResponse: [
          async (response, retryWithMergedOptions) => {
            logger.debug(`url: ${response.requestUrl}, response: ${response.body}`)
            if (response.statusCode === 400) {
              const { errorCode, errorMsg } = JSON.parse(response.body.toString()) as {
                errorCode: string
                errorMsg: string
              }
              if (errorCode === 'InvalidAccessToken') {
                logger.debug('InvalidAccessToken retry...')
                logger.debug('Refresh AccessToken')
                this.session.accessToken = ''
                this.forceRefresh = true
                return retryWithMergedOptions({})
              } else if (errorCode === 'InvalidSessionKey') {
                logger.debug('InvalidSessionKey retry...')
                logger.debug('Refresh InvalidSessionKey')
                this.session.sessionKey = ''
                this.forceRefresh = true
                return retryWithMergedOptions({})
              }
            }
            return response
          }
        ]
      }
    })
  }

  #valid = (options: ConfigurationOptions) => {
    if (!options.token && (!options.username || !options.password)) {
      logger.error('valid')
      throw new Error('Please provide username and password or token !')
    }
  }

  setProxy(proxyUrl: string | null) {
    this.proxyUrl = proxyUrl;
    this.authClient.setProxy(proxyUrl);
  }

  async getSession() {
    const { accessToken, expiresIn, refreshToken } = await this.tokenStore.get()

    if (!this.forceRefresh && accessToken && expiresIn && expiresIn > Date.now()) {
      try {
        return await this.authClient.loginByAccessToken(accessToken)
      } catch (e) {
        logger.error(e)
      }
    }

    if (refreshToken) {
      try {
        this.forceRefresh = false
        const refreshTokenSession = await this.authClient.refreshToken(refreshToken)
        await this.tokenStore.update({
          accessToken: refreshTokenSession.accessToken,
          refreshToken: refreshTokenSession.refreshToken,
          expiresIn: new Date(Date.now() + refreshTokenSession.expiresIn * 1000).getTime()
        })
        return await this.authClient.loginByAccessToken(refreshTokenSession.accessToken)
      } catch (e) {
        logger.error(e)
      }
    }

    if (this.ssonCookie) {
      try {
        this.forceRefresh = false
        const loginToken = await this.authClient.loginBySsoCooike(this.ssonCookie)
        await this.tokenStore.update({
          accessToken: loginToken.accessToken,
          refreshToken: loginToken.refreshToken,
          expiresIn: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).getTime()
        })
        return loginToken
      } catch (e) {
        logger.error(e)
      }
    }

    if (this.username && this.password) {
      try {
        this.forceRefresh = false
        const loginToken = await this.authClient.loginByPassword(this.username, this.password)
        await this.tokenStore.update({
          accessToken: loginToken.accessToken,
          refreshToken: loginToken.refreshToken,
          expiresIn: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).getTime()
        })
        return loginToken
      } catch (e) {
        logger.error(e)
      }
    }
    throw new Error('Can not get session.')
  }

  /**
   * 获取 sessionKey
   * @returns sessionKey
   */
  async getSessionKey() {
    if (this.session.sessionKey) {
      return this.session.sessionKey
    }
    if (!this.#sessionKeyPromise) {
      this.#sessionKeyPromise = this.getSession()
        .then((result) => {
          this.session.sessionKey = result.sessionKey
          return result
        })
        .finally(() => {
          this.#sessionKeyPromise = null
        })
    }
    const result = await this.#sessionKeyPromise
    return result.sessionKey
  }

  /**
   * 获取 accessToken
   * @returns accessToken
   */
  async getAccessToken() {
    if (this.session.accessToken) {
      return this.session.accessToken
    }
    if (!this.#accessTokenPromise) {
      this.#accessTokenPromise = this.#getAccessTokenBySsKey()
        .then((result) => {
          this.session.accessToken = result.accessToken
          return result
        })
        .finally(() => {
          this.#accessTokenPromise = null
        })
    }
    const result = await this.#accessTokenPromise
    return result.accessToken
  }

  /**
   * 获取用户网盘存储容量信息
   * @returns 账号容量结果
   */
  getUserSizeInfo(): Promise<UserSizeInfoResponse> {
    return this.request.get(`${WEB_URL}/api/portal/getUserSizeInfo.action`).json()
  }

  /**
   * 个人签到任务
   * @returns 签到结果
   */
  userSign(): Promise<UserSignResponse> {
    return this.request
      .get(
        `${WEB_URL}/mkt/userSign.action?rand=${new Date().getTime()}&clientType=TELEANDROID&version=${
          config.version
        }&model=${config.model}`
      )
      .json()
  }

  /**
   * 获取 accessToken
   */
  #getAccessTokenBySsKey(): Promise<AccessTokenResponse> {
    return this.request.get(`${WEB_URL}/api/open/oauth2/getAccessTokenBySsKey.action`).json()
  }

  /**
   * 获取家庭信息
   * @returns 家庭列表信息
   */
  getFamilyList(): Promise<FamilyListResponse> {
    return this.request.get(`${API_URL}/open/family/manage/getFamilyList.action`).json()
  }

  /**
   * 家庭签到任务
   * @param familyId - 家庭id
   * @returns 签到结果
   */
  familyUserSign(familyId: number): Promise<FamilyUserSignResponse> {
    return this.request
      .get(`${API_URL}/open/family/manage/exeFamilyUserSign.action?familyId=${familyId}`)
      .json()
  }
}
