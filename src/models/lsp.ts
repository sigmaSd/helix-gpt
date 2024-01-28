import EventEmitter from "node:events"
import { log } from "../utils"
import type { IService, Range, Diagnostic, EventRequest } from "./lsp.types"
import { Event, DiagnosticSeverity } from "./lsp.types"

class Service {
  emitter: EventEmitter
  capabilities: any
  currentUri?: string
  contentVersion: number
  language?: string
  contents: string

  constructor({ capabilities }: any) {
    this.emitter = new EventEmitter()
    this.capabilities = capabilities
    this.contentVersion = 0
    this.contents = ""
    this.registerDefault()
  }

  registerDefault() {
    this.on(Event.Initialize, async ({ ctx }) => {
      ctx.send({
        method: Event.Initialize,
        id: 0,
        result: {
          capabilities: this.capabilities
        }
      })
    })

    this.on(Event.DidOpen, ({ ctx, request }) => {
      ctx.currentUri = request.params.textDocument.uri
      ctx.contents = request.params.textDocument.text
      ctx.language = request.params.textDocument.languageId
      ctx.contentVersion = 0
      log("received didOpen", `language: ${ctx.language}`)
    })

    this.on(Event.Shutdown, () => {
      log("received shutdown request")
      process.exit(0)
    })

    this.on(Event.DidChange, async ({ ctx, request }) => {
      // Removing incremental updates for the moment
      // request.params.contentChanges.forEach((change) => {
      // this.positionalUpdate(change.text, change.range)
      // })
      this.contents = request.params.contentChanges[0].text
      ctx.currentUri = request.params.textDocument.uri
      ctx.contentVersion = request.params.textDocument.version
      log("received didChange", `language: ${ctx.language}`, `contentVersion: ${ctx.contentVersion}`)
    })
  }

  registerEventHandlers(handlers: Record<string, (lsp: IService) => void>) {
    Object.values(handlers).forEach((i: (lsp: IService) => void) => {
      i(this)
    })
  }

  getContentFromRange(range: Range): string {
    log("getting content from range", JSON.stringify(range), this.contents)
    const { start, end } = range
    return this.contents.split("\n").slice(start.line, end.line + 1).join("\n")
  }

  positionalUpdate(text: string, range: Range) {
    const lines = this.contents?.split("\n")
    const start = range.start.line
    const end = range.end.line
    const startLine = lines[start]
    const endLine = lines[end]
    const startLineStart = startLine?.substring(0, range.start.character)
    const endLineEnd = endLine?.substring(range.end.character)
    const newLines = [startLineStart + text + endLineEnd]

    const newContents = lines.reduce((acc, line, index) => {
      if (index < start || index > end) {
        acc.push(line)
      } else if (index === start) {
        acc.push(newLines[0])
      }
      return acc
    }, [])

    this.contents = newContents.join("\n")
  }

  on(event: string, callback: (request: EventRequest) => void) {
    const parent = this

    this.emitter.on(event, async (request) => {
      try {
        callback({ ctx: parent, request })
      } catch (e) {
        log("error in event", JSON.stringify(request), e.message)
      }
    })
  }

  send({ method, id, result, params }: { method?: Event, id?: number, result?: any, params?: any }) {
    if (result === null) return

    const request = JSON.stringify({
      jsonrpc: "2.0",
      method,
      id,
      result,
      params
    })

    console.log(`Content-Length: ${request.length}\r\n\r\n${request}`)
    log("sent request", request)
  }

  sendDiagnostics(diagnostics: Diagnostic[], timeout?: number = 0) {
    log("sending diagnostics", JSON.stringify(diagnostics))

    const params = {
      uri: this.currentUri,
      diagnostics: diagnostics.map((i) => {
        i.source = "helix-gpt"
        return i
      })
    }

    this.send({
      method: Event.PublishDiagnostics,
      params
    })

    if (timeout > 0) {
      setTimeout(() => {
        this.send({
          method: Event.PublishDiagnostics,
          params: {
            uri: this.currentUri,
            diagnostics: []
          }
        })
      }, timeout)
    }
  }

  resetDiagnostics() {
    this.send({
      method: Event.PublishDiagnostics,
      params: {
        uri: this.currentUri,
        diagnostics: []
      }
    })
  }

  async receiveLine(line: string) {
    try {
      const request = JSON.parse(line.split('\r\n')[2].split('Content-Length')[0])

      if (![Event.DidChange, Event.DidOpen].includes(request.method)) {
        log("received request:", JSON.stringify(request))
      }

      this.emitter.emit(request.method, request)
    } catch (e) {
      log("failed to parse line:", e.message, line)
    }
  }

  async start() {
    for await (const chunk of Bun.stdin.stream()) {
      const chunkText = Buffer.from(chunk).toString();
      this.receiveLine(chunkText)
    }
  }
}

export default {
  Service, Event, DiagnosticSeverity
}