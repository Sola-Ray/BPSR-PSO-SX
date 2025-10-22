import { Server } from 'socket.io';

let _io;

class Socket {
    init(server) {
        _io = new Server(server, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST'],
            },
        });
    }

    emit(event, data) {
        if (_io === null || _io === undefined) {
            throw "io must be initialized" 
        }

        _io.emit(event, data);
    }

    on(event, callback) {
        if (_io === null || _io === undefined) {
            throw "io must be initialized" 
        }

        _io.on(event, callback)
    }
}

const socket = new Socket();
export default socket;
