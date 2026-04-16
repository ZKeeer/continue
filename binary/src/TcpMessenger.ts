import { IProtocol } from "core/protocol";
import { IMessenger, Message } from "core/protocol/messenger";
import net from "net";
import { v4 as uuidv4 } from "uuid";

export class TcpMessenger<
  ToProtocol extends IProtocol,
  FromProtocol extends IProtocol,
> implements IMessenger<ToProtocol, FromProtocol>
{
  private port: number = 0; // 0 = OS assigns a free port
  private host: string = "127.0.0.1";
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;

  typeListeners = new Map<keyof ToProtocol, ((message: Message) => any)[]>();
  idListeners = new Map<string, (message: Message) => any>();

  constructor() {
    this.server = net.createServer((socket) => {
      this.socket = socket;
      socket.setNoDelay(true);

      socket.on("data", (data: Buffer) => {
        this._handleData(data);
      });

      socket.on("end", () => {
        console.log("Disconnected from server");
      });

      socket.on("error", (err: any) => {
        console.error("Client error:", err);
      });
    });

    this.server.on("error", (err: any) => {
      console.error(`TCP server error:`, err);
      process.exit(1);
    });

    this.server.listen(0, this.host, () => {
      const addr = this.server?.address();
      if (addr && typeof addr !== "string") {
        this.port = addr.port;
      }
      // Signal the port to the parent process via stderr
      process.stderr.write(`TCP_PORT:${this.port}\n`);
      console.log(`Server listening on port ${this.port}`);
    });
  }

  private _onErrorHandlers: ((message: Message, error: Error) => void)[] = [];

  onError(handler: (message: Message, error: Error) => void) {
    this._onErrorHandlers.push(handler);
  }

  public async awaitConnection(timeoutMs: number = 300000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        if (this.socket) {
          resolve();
        } else {
          const elapsed = Date.now() - startTime;
          if (elapsed > timeoutMs) {
            reject(new Error(`TCP connection timeout after ${timeoutMs}ms`));
          } else {
            setTimeout(check, 100);
          }
        }
      };
      check();
    });
  }

  private _handleLine(line: string) {
    try {
      const msg: Message = JSON.parse(line);
      if (msg.messageType === undefined || msg.messageId === undefined) {
        throw new Error("Invalid message sent: " + JSON.stringify(msg));
      }

      // Call handler and respond with return value
      const listeners = this.typeListeners.get(msg.messageType as any);
      listeners?.forEach(async (handler) => {
        try {
          const response = await handler(msg);
          if (
            response &&
            typeof response[Symbol.asyncIterator] === "function"
          ) {
            let next = await response.next();
            while (!next.done) {
              this.send(
                msg.messageType,
                {
                  done: false,
                  content: next.value,
                  status: "success",
                },
                msg.messageId,
              );
              next = await response.next();
            }
            this.send(
              msg.messageType,
              {
                done: true,
                content: next.value,
                status: "success",
              },
              msg.messageId,
            );
          } else {
            this.send(
              msg.messageType,
              {
                done: true,
                content: response,
                status: "success",
              },
              msg.messageId,
            );
          }
        } catch (e: any) {
          this.send(
            msg.messageType,
            { done: true, error: e.message, status: "error" },
            msg.messageId,
          );

          console.warn(`Error running handler for "${msg.messageType}": `, e);
          this._onErrorHandlers.forEach((handler) => {
            handler(msg, e);
          });
        }
      });

      // Call handler which is waiting for the response, nothing to return
      this.idListeners.get(msg.messageId)?.(msg);
    } catch (e) {
      let truncatedLine = line;
      if (line.length > 200) {
        truncatedLine =
          line.substring(0, 100) + "..." + line.substring(line.length - 100);
      }
      console.error("Error parsing line: ", truncatedLine, e);
      return;
    }
  }

  private _unfinishedLine: string | undefined = undefined;

  private _handleData(data: Buffer) {
    const d = data.toString();
    const lines = d.split(/\r\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return;
    }

    if (this._unfinishedLine) {
      lines[0] = this._unfinishedLine + lines[0];
      this._unfinishedLine = undefined;
    }
    if (!d.endsWith("\r\n")) {
      this._unfinishedLine = lines.pop();
    }
    lines.forEach((line) => this._handleLine(line));
  }

  private _writeQueue: string[] = [];
  private _writing = false;
  private _drainWaiters: (() => void)[] = [];

  private async _drain(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.socket || this.socket.writableEnded) {
        resolve();
        return;
      }
      const canWrite = this.socket.write("");
      if (canWrite !== false) {
        resolve();
        return;
      }
      this._drainWaiters.push(resolve);
      this.socket.once("drain", () => {
        const waiters = this._drainWaiters.splice(0);
        waiters.forEach((w) => w());
      });
    });
  }

  private async _flushQueue() {
    if (this._writing) return;
    this._writing = true;
    try {
      while (this._writeQueue.length > 0) {
        const data = this._writeQueue.shift()!;
        if (!this.socket || this.socket.writableEnded) break;
        const canWrite = this.socket.write(data);
        if (canWrite === false) {
          await this._drain();
        }
      }
    } catch (e) {
      console.error("[TcpMessenger] Write error:", e);
    } finally {
      this._writing = false;
    }
  }

  send<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
    messageId?: string,
  ): string {
    messageId = messageId ?? uuidv4();
    const msg: Message = {
      messageType: messageType as string,
      data,
      messageId,
    };

    const d = JSON.stringify(msg) + "\r\n";
    this._writeQueue.push(d);
    void this._flushQueue();
    return messageId;
  }

  on<T extends keyof ToProtocol>(
    messageType: T,
    handler: (message: Message<ToProtocol[T][0]>) => ToProtocol[T][1],
  ): void {
    if (!this.typeListeners.has(messageType)) {
      this.typeListeners.set(messageType, []);
    }
    this.typeListeners.get(messageType)?.push(handler);
  }

  invoke<T extends keyof ToProtocol>(
    messageType: T,
    data: ToProtocol[T][0],
  ): ToProtocol[T][1] {
    return this.typeListeners.get(messageType)?.[0]?.({
      messageId: uuidv4(),
      messageType: messageType as string,
      data,
    });
  }

  request<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
  ): Promise<FromProtocol[T][1]> {
    const messageId = uuidv4();
    return new Promise((resolve) => {
      const handler = (msg: Message) => {
        resolve(msg.data);
        this.idListeners.delete(messageId);
      };
      this.idListeners.set(messageId, handler);
      this.send(messageType, data, messageId);
    });
  }
}
