import { RTTCommonDecoderOpts, RTTConsoleDecoderOpts } from "../adapter/servers/common";
import { getHostAdapter, IDebugSession } from "./host-adapter";
import { CDebugSession } from "./mcu-debug-session";
import { JLinkSocketRTTSource, SocketRTTSource } from "./swo/sources/socket";

export function createRTTSource(mySession: CDebugSession, tcpPort: string, channel: number): Promise<SocketRTTSource> {
    return new Promise((resolve, reject) => {
        let src = mySession.rttPortMap[channel];
        if (src) {
            resolve(src);
            return;
        }
        let decoderSpec = mySession.config.rttConfig?.enabled && mySession.config.rttConfig?.pre_decoder;
        if (decoderSpec && mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
            decoderSpec = undefined;
        }
        if (mySession.config.servertype === "jlink") {
            src = new JLinkSocketRTTSource(channel, tcpPort, decoderSpec);
        } else {
            src = new SocketRTTSource(channel, tcpPort, decoderSpec);
        }
        mySession.rttPortMap[channel] = src; // Yes, we put this in the list even if start() can fail
        resolve(src); // Yes, it is okay to resolve it even though the connection isn't made yet
        src.start()
            .then(() => {
                if (!mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
                    mySession.session.customRequest("rtt-poll");
                }
            })
            .catch((e) => {
                getHostAdapter().showError(`Could not connect to RTT TCP port ${tcpPort} ${e}`);
            });
    });
}

export function handleRTTConfigureEvent(body: any, session: CDebugSession, createCb: (opts: RTTConsoleDecoderOpts, src: SocketRTTSource) => void) {
    if (body.type === "socket") {
        const decoder: RTTCommonDecoderOpts = body.decoder;
        if (decoder.type === "console" || decoder.type === "binary") {
            createRTTSource(session, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
                createCb(decoder as RTTConsoleDecoderOpts, src);
            });
        } else {
            if (!decoder.ports) {
                createRTTSource(session, decoder.tcpPort, decoder.port);
            } else {
                for (let ix = 0; ix < decoder.ports.length; ix = ix + 1) {
                    // Hopefully ports and tcpPorts are a matched set
                    createRTTSource(session, decoder.tcpPorts[ix], decoder.ports[ix]);
                }
            }
        }
    } else {
        getHostAdapter().debugMessage("Error: receivedRTTConfigureEvent: unknown type: " + body.type);
    }
}
