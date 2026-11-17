import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 读取「原始二进制」请求体（大文件上传用）。
 *
 * 为什么不用 multer / FileInterceptor：
 *   1. 本项目的上传都是「单文件直传」，不需要多字段表单解析；
 *   2. 前端用 XHR 直传 `application/octet-stream` 才能拿到上传进度；
 *   3. 少一层 multipart 解析 = 少一个依赖、少一处「临时文件落在哪」的问题。
 *
 * 前提：请求的 Content-Type 不能是 application/json（Express 的 json 解析器
 * 会先把流读干）。统一用 `application/octet-stream`，body 原样是文件字节。
 */
export async function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared && declared > maxBytes) {
    throw new PayloadTooLargeException(
      `文件过大：${(declared / 1024 / 1024).toFixed(1)}MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    // 边读边判：不能等读完再判，否则超限文件已经把内存吃完了
    if (total > maxBytes) {
      throw new PayloadTooLargeException(
        `文件过大：已读 ${(total / 1024 / 1024).toFixed(1)}MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
      );
    }
    chunks.push(buf);
  }

  if (total === 0) {
    throw new BadRequestException('文件内容为空：请以 application/octet-stream 提交文件二进制');
  }
  return Buffer.concat(chunks, total);
}

/** 从文件名取扩展名（小写，含点）；取不到返回空串 */
export function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '');
  return m ? `.${m[1].toLowerCase()}` : '';
}
