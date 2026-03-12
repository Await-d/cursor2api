export interface QueuedTask<T> {
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    enqueuedAt: number;
    id: string;
}

export class RequestAbortedError extends Error {
    constructor() {
        super('Request aborted');
    }
}

export interface RequestQueueOptions {
    concurrency: number;
    queueTimeout: number;
    /** 收到 429 后的初始退避时间（ms） */
    retryDelay: number;
    /** 退避时间最大上限（ms） */
    maxRetryDelay: number;
}

const DEFAULT_OPTIONS: RequestQueueOptions = {
    concurrency: 3,
    queueTimeout: 120_000,
    retryDelay: 5_000,
    maxRetryDelay: 60_000,
};

let _taskCounter = 0;
function nextTaskId(): string {
    return `Q${(++_taskCounter).toString().padStart(4, '0')}`;
}

export class RequestQueue {
    private options: RequestQueueOptions;
    private running = 0;
    private queue: Array<QueuedTask<unknown>> = [];

    constructor(options: Partial<RequestQueueOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        console.log(`[Queue] 初始化完成: 并发上限=${this.options.concurrency}, 队列超时=${this.options.queueTimeout / 1000}s, 429初始退避=${this.options.retryDelay / 1000}s`);
    }

    updateOptions(options: Partial<RequestQueueOptions>): void {
        this.options = { ...this.options, ...options };
    }

    get activeCount(): number {
        return this.running;
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    enqueue<T>(fn: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const taskId = nextTaskId();
            const enqueuedAt = Date.now();
            const signal = options.signal;
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

            let onAbort: (() => void) | null = null;
            const cleanupAbort = () => {
                if (signal && onAbort) {
                    signal.removeEventListener('abort', onAbort);
                    onAbort = null;
                }
            };

            const abortTask = () => {
                const idx = this.queue.findIndex(t => t.id === taskId);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                }
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                reject(new RequestAbortedError());
            };

            if (signal?.aborted) {
                abortTask();
                return;
            }

            if (signal) {
                onAbort = () => {
                    cleanupAbort();
                    abortTask();
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }

            const task: QueuedTask<unknown> = {
                fn: fn as () => Promise<unknown>,
                resolve: (value: unknown) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                    cleanupAbort();
                    resolve(value as T);
                },
                reject: (reason: unknown) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                    cleanupAbort();
                    reject(reason);
                },
                enqueuedAt,
                id: taskId,
            };

            if (this.running < this.options.concurrency) {
                this.run(task);
            } else {
                this.queue.push(task);
                console.log(`[Queue] [${taskId}] 入队等待 (运行中=${this.running}/${this.options.concurrency}, 队列长度=${this.queue.length})`);

                timeoutHandle = setTimeout(() => {
                    const idx = this.queue.findIndex(t => t.id === taskId);
                    if (idx !== -1) {
                        this.queue.splice(idx, 1);
                        const waited = Date.now() - enqueuedAt;
                        console.error(`[Queue] [${taskId}] 队列等待超时 (等待了 ${waited}ms)，任务被丢弃`);
                        reject(new Error(`Request queue timeout after ${waited}ms`));
                    }
                }, this.options.queueTimeout);
            }
        });
    }

    private run(task: QueuedTask<unknown>): void {
        this.running++;
        const waitMs = Date.now() - task.enqueuedAt;
        if (waitMs > 50) {
            console.log(`[Queue] [${task.id}] 开始执行 (等待了 ${waitMs}ms, 运行中=${this.running}/${this.options.concurrency})`);
        }

        task.fn()
            .then(result => task.resolve(result))
            .catch(err => task.reject(err))
            .finally(() => {
                this.running--;
                this.dispatch();
            });
    }

    private dispatch(): void {
        if (this.queue.length === 0 || this.running >= this.options.concurrency) return;
        const next = this.queue.shift()!;
        const waited = Date.now() - next.enqueuedAt;
        console.log(`[Queue] [${next.id}] 出队执行 (排队等待 ${waited}ms, 队列剩余=${this.queue.length})`);
        this.run(next);
    }

    /**
     * 指数退避 + ±20% 随机抖动，防止 429 惊群效应
     * delay = min(base * 2^(attempt-1), max) * (1 ± 0.2)
     */
    static computeRetryDelay(attempt: number, baseDelay: number, maxDelay: number): number {
        const exp = Math.min(attempt, 6);
        const delay = Math.min(baseDelay * Math.pow(2, exp - 1), maxDelay);
        const jitter = delay * 0.2 * (Math.random() * 2 - 1);
        return Math.round(delay + jitter);
    }
}

let _instance: RequestQueue | null = null;

export function initQueue(options: Partial<RequestQueueOptions>): void {
    _instance = new RequestQueue(options);
}

export function getQueue(): RequestQueue {
    if (!_instance) {
        _instance = new RequestQueue();
    }
    return _instance;
}
