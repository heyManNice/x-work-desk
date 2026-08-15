/* 转储 CONFIG 消息中的 SPS/PPS 字节 */
const enc = new TextEncoder();
function msgLogin(user, pass) {
    const u = enc.encode(user), p = enc.encode(pass);
    const b = new Uint8Array(1 + 2 + u.length + 2 + p.length);
    let o = 0;
    b[o++] = 0x10;
    b[o++] = u.length & 0xff; b[o++] = (u.length >> 8) & 0xff;
    b.set(u, o); o += u.length;
    b[o++] = p.length & 0xff; b[o++] = (p.length >> 8) & 0xff;
    b.set(p, o);
    return b;
}
const ws = new WebSocket('ws://localhost:5268/ws');
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(msgLogin('cd2', 'x'));
ws.onmessage = (ev) => {
    const b = new Uint8Array(ev.data);
    if (b[0] === 0x02) {
        let o = 1;
        const w = b[o] | (b[o + 1] << 8); o += 2;
        const h = b[o] | (b[o + 1] << 8); o += 2;
        const sl = b[o] | (b[o + 1] << 8); o += 2;
        const sps = b.subarray(o, o + sl); o += sl;
        const pl = b[o] | (b[o + 1] << 8); o += 2;
        const pps = b.subarray(o, o + pl);
        console.log(`SPS(${sps.length}) =`, Buffer.from(sps).toString('hex'));
        console.log(`PPS(${pps.length}) =`, Buffer.from(pps).toString('hex'));
        console.log('sps[0]=' + sps[0].toString(16), 'sps[1]=' + sps[1].toString(16),
            'sps[2]=' + sps[2].toString(16), 'sps[3]=' + sps[3].toString(16));
        process.exit(0);
    }
};
setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000);
