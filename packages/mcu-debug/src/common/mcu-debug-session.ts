import { assert } from "console";
import { ConfigurationArguments, ChainedConfig } from "../adapter/servers/common";
import { RTTCore, SWOCore } from "./swo/swo-core";
import { SWORTTSource } from "./swo/sources/common";
import { SocketRTTSource, SocketUARTSource } from "./swo/sources/socket";
import { IDebugConfiguration, IDebugSession, getHostAdapter } from "./host-adapter";

export class CDebugSession {
    public swo: SWOCore | null = null;
    public rtt: RTTCore | null = null;
    public swoSource: SWORTTSource | null = null;
    public rttPortMap: { [channel: number]: SocketRTTSource } = {};
    public rttUARTMap: { [path: string]: SocketUARTSource } = {};
    // Status can be 'none' before the session actually starts but this object
    // may have been created before that actually happens due to SWO, RTT, chained
    // launches, etc
    public status: "started" | "stopped" | "running" | "exited" | "none" = "none";

    protected parent: CDebugSession | null = null;
    protected children: CDebugSession[] = [];
    public static CurrentSessions: CDebugSession[] = []; // This may stuff that never fully got created
    private static ROOT = new CDebugSession({} as IDebugSession, {} as ConfigurationArguments, true); // Dummy node for all sessions trees
    public usedPorts: Set<number> = new Set<number>();

    constructor(
        public session: IDebugSession,
        public config: ConfigurationArguments | IDebugConfiguration,
        isRoot: boolean = false,
    ) {
        if (!isRoot) {
            CDebugSession.CurrentSessions.push(this);
        }
    }

    public getRoot(): CDebugSession {
        return this.parent && this.parent.parent ? this.parent.getRoot() : this;
    }

    public hasChildren(): boolean {
        return this.children.length > 0;
    }

    public moveToRoot() {
        if (this.parent) {
            this.remove();
            CDebugSession.ROOT.add(this);
        }
    }

    // Depth-First Search (DFS): walks the session tree recursively, visiting each
    // node's children before the node itself (post-order). This means child sessions
    // are always visited before their parent — intentional for operations like pauseAll,
    // where children should halt before the parent so the master core doesn't advance
    // while slaves are still running.
    public broadcastDFS(cb: (s: CDebugSession) => void, fromRoot: boolean = true) {
        const root = fromRoot ? this.getRoot() : this;
        root._broadcastDFS(cb);
    }

    protected _broadcastDFS(cb: (s: CDebugSession) => void) {
        for (const child of this.children) {
            child._broadcastDFS(cb);
        }
        cb(this);
    }

    private remove() {
        this.parent?.removeChild(this);
    }

    public add(child: CDebugSession) {
        assert(!child.parent, "child already has a parent?");
        if (this.children.find((x) => x === child)) {
            assert(false, "child already exists");
        } else {
            this.children.push(child);
            child.parent = this;
        }
    }

    private removeChild(child: CDebugSession) {
        this.children = this.children.filter((x) => x !== child);
        child.parent = null;
    }

    public stopAll() {
        this.broadcastDFS((arg) => {
            getHostAdapter().stopDebugging(arg.session!);
        });
    }

    public static RemoveSession(session: IDebugSession) {
        const s = CDebugSession.FindSession(session);
        if (s) {
            s.status = "exited";
            s.remove();
            CDebugSession.CurrentSessions = CDebugSession.CurrentSessions.filter((s) => s.session?.id !== session.id);
        } else {
            console.error(`Where did session ${session.id} go?`);
        }
    }

    public static FindSession(session: IDebugSession) {
        return CDebugSession.FindSessionById(session.id);
    }

    public static FindSessionById(id: string) {
        const ret = CDebugSession.CurrentSessions.find((x) => x.session?.id === id);
        return ret;
    }

    public static GetSession(session: IDebugSession, config?: ConfigurationArguments): CDebugSession {
        const prev = CDebugSession.FindSessionById(session.id);
        if (prev) {
            prev.config = config || prev.config;
            return prev;
        }
        return new CDebugSession(session, config || session.configuration);
    }

    // Call this method after session actually started. It inserts new session into the session tree
    public static NewSessionStarted(session: IDebugSession): CDebugSession {
        const newSession = CDebugSession.GetSession(session); // May have already in the global list
        newSession.status = "started";
        if (session.parentSession && session.parentSession.type === "mcu-debug") {
            const parent = CDebugSession.FindSession(session.parentSession);
            if (!parent) {
                getHostAdapter().showError(
                    `Internal Error: Have parent for new session, Parent = ${session.parentSession.name} but can't find it`,
                );
            } else {
                parent.add(newSession); // Insert into tree
            }
        } else {
            CDebugSession.ROOT.add(newSession);
        }
        return newSession;
    }

    public static getAllUsedPorts(): number[] {
        const ports = new Set<number>();
        for (const s of CDebugSession.CurrentSessions) {
            if (s.status === "started" || s.status === "stopped" || s.status === "running") {
                for (const p of s.usedPorts.values()) {
                    ports.add(p);
                }
            }
        }
        return Array.from(ports.values());
    }

    public addUsedPorts(ports: number[]) {
        for (const p of ports) {
            this.usedPorts.add(p);
        }
    }
}

export class CDebugChainedSessionItem<TSessionOptions = unknown> {
    public static SessionsStack: CDebugChainedSessionItem[] = [];
    constructor(
        public parent: CDebugSession,
        public config: ChainedConfig,
        public options: TSessionOptions,
    ) {
        CDebugChainedSessionItem.SessionsStack.push(this);
    }

    public static FindByName(name: string): CDebugChainedSessionItem | undefined {
        return this.SessionsStack.find((x) => x.config.name === name);
    }

    public static RemoveItem(item: CDebugChainedSessionItem) {
        CDebugChainedSessionItem.SessionsStack = CDebugChainedSessionItem.SessionsStack.filter((x) => x !== item);
    }
}
