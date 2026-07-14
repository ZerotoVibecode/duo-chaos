declare module 'jsdom' {
  export interface ConstructorOptions {
    runScripts?: 'dangerously' | 'outside-only'
    url?: string
  }

  export interface DOMWindow extends Window {
    readonly HTMLElement: typeof HTMLElement
    eval: (source: string) => unknown
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions)
    readonly window: DOMWindow
  }
}
