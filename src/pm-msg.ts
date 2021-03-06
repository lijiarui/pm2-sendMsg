import Brolog from 'brolog'
const pm2 = require('pm2')
const timeLimit = require('time-limit-promise')
const log = new Brolog()
const TIMEOUT = 60 * 1000
log.level(<any>process.env['LOG'] || 'verbose')

export interface pmObj {
  pid:      number,
  name:     string,
  pm2_env:  pmEnvObj,
  pm_id:    number,
  monit:    pmMonitObj,
}

export interface pmEnvObj {
  status:             string, // 'online', ....
  exec_mode:          string, // 'cluster_mode', ...
  instances:          number,
  max_memory_restart: number,
  name:               string,
  pm_id:              number,
  restart_time:       number,
}

export interface pmMonitObj {
  memory: number,
  cpu:    number
}

export interface processObj {
  script:               string,    
  instances:            number,    
  name:                 string,       
  max_memory_restart:   string,       // '100M' 
}

export interface sendObj {
  data:   Object, // { msg: 'send message: Hi, what is your name?' }
  topic:  string, // 'login'
}

export interface processResObj {
  process:  neatPmObj,
  data:     Object,     // { msg: 'response: My name is Alice', success: true },
  at:       number,     // timestamp 
}

export interface neatPmObj {
  rev:    string, // e1cc1f769bedde15ff025b47f1ee1a73242a7d29
  name:   string,
  pm_id:  number, 
}

/**
 * main
 * @class pmMsg
 */
export class pmMsg {

  public static MSGLISTEN = 'msg' 

  /**
   * 
   * Same with `pm2.connect()`
   * @static
   * @returns {Promise<void>} none
   * @example
   * await pmMsg.connect()
   */
  public static async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      pm2.connect(function (err) {
        if (err) {
          log.error('PM_MSG CONNECT', 'cannot connect to pm2')
          process.exit(2)
        }
        resolve()
      })
    })
  }

  /**
   * 
   * Same with `pm2.disconnect()`
   * @static
   * @example
   * pmMsg.disconnect()
   */
  public static disconnect(): void {
    pm2.disconnect()
  }

  /**
   * 
   * Same with `pm2.list` Gets the list of running processes being managed by pm2.
   * @static
   * @returns {Promise} return object array pmObj[]
   * @example
   * await pmMsg.pmList()
   */
  public static async pmList(): Promise <pmObj[]> {
    return new Promise<pmObj[]>((resolve, reject) => {
      pm2.list((err, data) => {
        if (err) {
          reject('PM_MSG ERROR:' + err)
        }
        resolve(data)
      })
    })
  }

  /**
   * 
   * Check if exist the named process.
   * @static
   * @param {string} name 
   * @returns {Promise<boolean>} true for exsit, false for no name exsit in pm2 list.
   * @example
   * await pmMsg.pmNameExsit('script') // check if has a process named with script
   */
  public static async pmNameExsit(name: string): Promise<boolean> {
    const list = await pmMsg.pmList()
    for (let i in list) {
      if (list[i].name === name) {
        return true
      }
    }
    return false
  }

  /**
   * 
   * Starts a script that will be managed by pm2.   
   * Only support `cluster` mode   
   * Will check if the script name exist, if exist, will delete first, then start the process
   * @static
   * @param {processObj} opt 
   * @example
   * const option = {
   *   script:             './example/script.ts',    
   *   instances:          2,    
   *   name:               'script',       
   *   max_memory_restart: '100M'          
   * }
   * pmMsg.start(option)
   */
  public static async start(opt: processObj) {
    return new Promise(async (resolve, reject) => {
      opt['exec_mode'] = 'cluster'
      const nameExsit = await pmMsg.pmNameExsit(opt.name)
  
      if (nameExsit) {
        await pmMsg.killRaw(opt.name)
      }

      pm2.start(opt, function (err, apps) {
        pm2.disconnect()
        
        if (apps === [undefined] || apps === []) {
          log.error('PM_MSG ERROR', 'cannot start process successfully, please check the start script!')
          return
        }

        if (apps[0].pm2_env.pm_id !== undefined) {
          log.verbose('PM_MSG START', 'start pm2 successfully! pm name: %s', opt.name)
          resolve(apps)
        } else {
          log.error('PM_MSG START','ERROR, cannot get pm_id')
          return
        }
        if (err) {
          log.error('PM_MSG START', err)
          process.exit(2)
        }
      })
    })
  }

  /**
   * 
   * Send message to process managed by pm2.    
   * Just send to one process instead of send message to all process named with `name`.
   * Will auto disconnect when send over.
   * Return undefined if cannot get the result
   * @static
   * @param {string} name 
   * @param {sendObj} content 
   * @returns {Promise<processResObj | undefined>} 
   * @example
   * pmMsg.send('script', {
   *   data: { msg: 'send message: Hi, what is your name?' },
   *   topic: 'login'
   * })
   */
  public static async send(name: string, content: sendObj): Promise<processResObj | undefined> {
    return new Promise<processResObj>(async (resolve, reject) => {
      pm2.launchBus(function (err, pm2_bus) {
        timeLimit(pmMsg.receive(pm2_bus), TIMEOUT).then(res => {
          if (!res) {
            log.error('PM_MSG SEND', 'cannot get response in %d, disconnect automatically', TIMEOUT)
          } 
          pm2.disconnect()
          resolve(res)
        })
      })
      const pmProcess = await pmMsg.getProcess(name)
      if (pmProcess) {
        content['id'] = pmProcess.pm_id
        content['type'] = pmMsg.MSGLISTEN
        pm2.sendDataToProcessId(content['id'], content, function (err, res) {
          if (err) reject ('PM_MSG ERROR:' + err)
          log.verbose('PM_MSG SEND', 'send the message: %s successfully!', JSON.stringify(content))
        })
      } else {
        log.error('PM_MSG SEND', 'cannot find the process named with %s', name)
        pm2.disconnect()
        return
      }
    })
  }

  /**
   * 
   * Find one process by name, if many, return the first one.
   * Should disconnect when done.
   * @static
   * @param {any} name 
   * @returns {(Promise<pmObj | null>)} 
   */
  public static async getProcess(name): Promise<pmObj | null> {
    const list = await pmMsg.pmList()
    for (let i in list) {
      let pmProcess = list[i]
      if (pmProcess.name === name && pmProcess.pm2_env.status === 'online') {
        return pmProcess
      }
    }
    return null
  }

  /**
   * @private
   */
  public static async receive(pm2_bus) {
    return new Promise((resolve, reject) => {
      pm2_bus.on(pmMsg.MSGLISTEN, function (packet) {
        log.verbose('PM_MSG RECEIVE', 'get response: %s', JSON.stringify(packet))
        resolve(packet)
      })
    })
  }

  /**
   * 
   * Stops the process and removes it from pm2’s list. 
   * Same with `pm2.delete()`
   * Will check whethe delete the process successfully. If delete successfully, return true, else, return false.
   * @static
   * @param {string} name 
   * @returns {Promise<boolean>} 
   */
  public static async kill(name: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      pm2.delete(name, async (err) => {
        pm2.disconnect()
        if (err) {
          reject('PM_MSG ERROR:' + err)
        }
        log.info('PM_MSG KILL', 'kill name %s successfully', name)

        const nameExsit = await pmMsg.pmNameExsit(name)
        if (nameExsit) {
          log.error('PM_MSG KILL', 'failed to kill name %s', name)
          resolve(false)
        }
        resolve(true)
      })
    })
  }

  /**
   * @private
   */
  public static async killRaw(name: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      pm2.delete(name, async (err) => {
        if (err) {
          reject('PM_MSG ERROR:' + err)
        }
        log.info('PM_MSG KILL', 'kill name %s successfully', name)

        const nameExsit = await pmMsg.pmNameExsit(name)
        if (nameExsit) {
          log.error('PM_MSG KILL', 'failed to kill name %s', name)
          resolve(false)
        }
        resolve(true)
      })
    })
  }

}