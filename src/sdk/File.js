import Chunk from './Chunk.js'
import utils from './utils.js'
import { Status } from './constans.js'

export default class File {
  constructor(uploader, file) {
    this.uploader = uploader
    this.opts = uploader.opts

    this.rawFile = file
    if (utils.isFunction(this.opts.generateUniqueIdentifier)) {
      this.id = this.opts.generateUniqueIdentifier(file) || utils.generateUid('fid')
    } else {
      this.id = utils.generateUid('fid')
    }
    this.size = file.size
    this.name = file.name || file.fileName
    this.type = file.type
    this.chunkSize = this.opts.chunkSize

    this.status = Status.Ready
    this.progress = 0
    this.chunks = []
    this.uploadingQueue = new Set()

    this.createChunks()
  }

  createChunks() {
    const blob = new Blob([this.rawFile], {
      size: this.size
    })
    const chunks = this.slice(blob)
    this.chunks = chunks.map((chunk, index) => {
      return new Chunk(this, chunk, index)
    })
  }

  slice(blob, size = this.chunkSize) {
    const fileChunkList = []
    let cur = 0
    while (cur < blob.size) {
      fileChunkList.push(blob.slice(cur, cur + size))
      cur += size
    }
    return fileChunkList
  }

  setProgress() {
    const progress = this.chunks.reduce((total, chunk) => {
      return (total += chunk.progressInFile)
    }, 0)
    if (this.status !== Status.Success) {
      this.progress = Math.max(Math.min(progress, 0.99), this.progress)
    }

    if (this.status === Status.Success) {
      this.progress = 1
    }

    this.uploader.emit('fileProgress', this.progress, this, this.uploader.fileList)
  }

  removeChunkInUploadingQueue(chunk) {
    this.uploadingQueue.delete(chunk)
  }

  addChunkInUploadingQueue(chunk) {
    this.uploadingQueue.add(chunk)
  }

  retryUpload() {
    this.chunks.forEach((chunk) => {
      if (chunk.status === Status.Fail) {
        chunk.status = Status.Ready
        chunk.retries = this.opts.retries
      }
    })
    this.uploadFile()
  }

  uploadFile() {
    const nextUploadChunks = this.chunks.filter((chunk) => chunk.status === Status.Ready)

    const run = () => {
      if (this.uploadingQueue.size >= this.uploader.opts.concurrency) {
        return
      }

      const chunk = nextUploadChunks.shift()
      if (!chunk) {
        return
      }
      this.addChunkInUploadingQueue(chunk)
      run()
    }

    run()
    // console.log(this.uploadingQueue)
    if (this.uploadingQueue.size === 0) {
      const hasErrorChunk = this.chunks.some((chunk) => chunk.status === Status.Fail)
      if (hasErrorChunk) {
        this.status = Status.Fail
        this.uploader.emit('fileFail', this, this.uploader.fileList)
      } else {
        this.status = Status.Success
        this.setProgress()
        this.uploader.emit('fileSuccess', this, this.uploader.fileList)
        const merge = this.uploader.opts.merge
        if (merge && utils.isFunction(merge)) {
          const p = merge(this)
          if (p && p.then) {
            p.then(
              () => {
                console.log('合并文件成功')
              },
              () => {
                console.log('合并文件失败')
              }
            )
          }
        }
      }
      this.uploader.upload()
      return
    }

    Promise.race(
      [...this.uploadingQueue]
        .filter((chunk) => chunk.status === Status.Ready)
        .map((chunk) => chunk.send())
    )
  }

  remove() {
    this.chunks = []
    this.uploadingQueue.forEach((chunk) => {
      chunk.abort()
    })
  }

  pause() {
    this.status = Status.Pause
    this.uploadingQueue.forEach((chunk) => {
      chunk.abort()
    })
  }

  pauseThenUpload() {
    this.pause()
    this.uploader.upload()
  }

  resume() {
    if (this.status === Status.Pause) {
      this.status = Status.Resume
      this.uploader.upload(true)
    }
  }
}
