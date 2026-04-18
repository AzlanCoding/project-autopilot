import { type Logger } from "pino";
import { getTime } from "../utils/common";


export class BufferSystem {
  private logger: Logger;
  chatBuffers: {
    [index: string]: {
      status: 'WAITING' | 'RUNNING',
      timeout?: NodeJS.Timeout
      func: () => Promise<void>
      lastUpdate: number;
    }
  } = {}

  constructor(logger: Logger) {
    this.logger = logger;
  }

  bufferCall(id: string, func: () => Promise<void>) {
    if (this.chatBuffers[id]) {
      if (this.chatBuffers[id].status == 'WAITING') {
        this.logger.info("Buffer already waiting! Re-buffering for " + id);
        clearTimeout(this.chatBuffers[id].timeout);
        this.chatBuffers[id].timeout = setTimeout(() => {
          this.logger.info("Buffer running for " + id);
          this.chatBuffers[id].status = 'RUNNING';
          this.chatBuffers[id].lastUpdate = getTime();
          func().finally(() => {
            this.logger.info("Deleting buffer " + id);
            delete this.chatBuffers[id];
          })
        }, 3000);
        this.chatBuffers[id].func = func;
        this.chatBuffers[id].lastUpdate = getTime();
      }
      else {
        this.logger.info("Buffer already running! Re-buffers in 3 sec... for " + id);
        setTimeout(() => this.bufferCall(id, func), 3000);
      }

    }
    else {
      this.logger.info("Started buffer for " + id);
      this.chatBuffers[id] = {
        status: 'WAITING',
        timeout: setTimeout(() => {
          this.logger.info("Buffer running for " + id);
          this.chatBuffers[id].status = 'RUNNING';
          this.chatBuffers[id].lastUpdate = getTime();
          func().finally(() => {
            this.logger.info("Deleting buffer " + id);
            delete this.chatBuffers[id];
          })
        }, 3000),
        func,
        lastUpdate: getTime()
      }

      // TODO: If bot has a tendency to not reply, then precense update not reliable, implement checkIdle to force reply / force stop after maybe 60 sec.
      // const checkIdle 
    }
  }

  pauseBuffer(id: string) {
    this.logger.info("Buffer paused for " + id);
    clearTimeout(this.chatBuffers[id].timeout);
    this.chatBuffers[id].lastUpdate = getTime();
  }

  resumeBuffer(id: string) {
    this.logger.info("Buffer resumed for " + id);
    if (this.chatBuffers[id].timeout) {
      clearTimeout(this.chatBuffers[id].timeout);
    }
    this.chatBuffers[id].status = 'WAITING'
    this.chatBuffers[id].timeout = setTimeout(() => {
      this.logger.info("Buffer running for " + id);
      this.chatBuffers[id].status = 'RUNNING';
      this.chatBuffers[id].lastUpdate = getTime();
      this.chatBuffers[id].func().finally(() => {
        this.logger.info("Deleting buffer " + id);
        delete this.chatBuffers[id];
      })
    }, 3000)
    this.chatBuffers[id].lastUpdate = getTime();
  }
}