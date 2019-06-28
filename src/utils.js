const crypto = require('crypto');
const fs = require('fs');
const path = require('path');


/** @typedef {import('fs').Dirent} Dirent*/

/**
 * @param {object} obj
 * @param {string[]} requiredKey
 */
function validateRequired(obj, requiredKey) {
  for (let i = 0, l = requiredKey.length; i < l; i++) {
    const key = requiredKey[i];
    if (obj[key] === null || obj[key] === undefined) {
      throw new Error(`Missing required property: ${key}`);
    }
  }
}

/**
 * 从文件名中移除prefix
 * @param {string} filename 文件名
 * @param {string} [prefix=''] 前缀
 */
function removePrefix(filename, prefix = '') {
  const prefixLength = prefix.length;
  if (prefixLength !== 0 && filename.slice(0, prefixLength) === prefix) {
    return filename.slice(prefixLength);
  } else {
    return filename;
  }
}

/**
 * 加载远程文件
 * @param {string} url 
 * @param {(error: Error, statusCode: number, content: String) => void} callback 
 */
function readRemoteFile(url, callback) {
  const request = /^https:/.test(url) ? require('https') : require('http');
  const randomKey = Math.random().toString().replace('.', '');
  request.get(`${url}?q=${randomKey}`, res => {
    let responseData = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      responseData += chunk;
    });
    res.on('end', () => {
      callback(null, res.statusCode, responseData);
    });
    res.resume();
  })
    .on('error', error => {
      callback(error);
    });
  ;
}
/**
 * @param {string} rootDir
 * @param {(error: Error | null, filePaths: string[]) => void} callback
 */
function listLocalFiles(rootDir, callback) {
  let result = [];
  const walk = (dir, walkCallback) => {
    fs.readdir(dir, { withFileTypes: true }, (err, dirents) => {
      if (err) {
        walkCallback(err);
        return;
      }
      asyncQueue(
        dirents,
        5,
        /** @param {Dirent} dirent */
        (dirent, asyncCb) => {
          const pathName = path.join(dir, dirent.name);
          if (dirent.isDirectory()) {
            walk(pathName, asyncCb);
          } else {
            result.push(pathName);
            asyncCb();
          }
        },
        walkCallback
      )
    });
  };
  walk(rootDir, error => {
    callback(error, result);
  });
}

/**
 * 异步执行队列
 * @param {any[]} list
 * @param {number} limit
 * @param {item: any, callback: ((error: Error | null) => void)} handler
 * @param {(error: Error | null) => void} callback
 */
function asyncQueue(list, limit, handler, callback) {
  let i = 0;
  limit = Math.min(list.length, limit);
  const queue = list.slice();

  if (limit === 0) {
    callback();
    return;
  }

  const tick = () => {
    const cur = queue.shift();
    handler(cur, err => {
      if (err) {
        callback(err);
      } else if (queue.length) {
        tick();
      } else if (--i === 0) {
        callback();
      }
    });
  }

  while (i < limit && queue.length) {
    i++;
    tick();
  }
}

/**
 * 计算buffer的sha1值
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function hashChunk(buf) {
  const sha1 = crypto.createHash('sha1');
  sha1.update(buf);
  return sha1.digest();
}

/**
 * 根据指定大小分割数组
 * @param {any[]} list 数组
 * @param {number} size 大小
 */
function splitList(list, size) {
  const urlQueue = [];
  list = list.slice();
  while (list.length) {
    urlQueue.push(list.splice(0, size));
  }
  return urlQueue;
}

/**
 * 执行任务队列，当队列中所有成员执行
 * @param {((callback: (errror: Error | null) => void) => void)[]} list 
 * @param {(error: Error | null, errorIndex: number | null)} callback 
 */
function taskQueue(list, callback) {
  let i = list.length;
  if (i === 0) {
    callback();
  }
  list.forEach((item, i) => {
    item(error => {
      if (error) {
        callback(error);
      } else if (--i === 0) {
        callback();
      }
    });
  });
}

function filePath2Uri(filepath) {
  return filepath.replace(/\\/g, '/');
}

/**
 * @param {string[][]} rows 
 * @param {string} title 
 */
function drawTable(rows, title) {
  const colNum = rows[0] ? rows[0].length : 1;
  const colWidth = rows.reduce(
    (width, row) => row.map((col, index) => Math.max(width[index], col.length)),
    new Array(colNum).fill(0)
  );
  let tableContentWidth = colWidth.reduce((acc, cur) => acc + cur, 0);
  if (tableContentWidth < title.length) {
    const space = title.length - tableContentWidth;
    colWidth[0] += space;
    tableContentWidth += space;
  }
  const tableWidth = tableContentWidth + colNum * 3 + 1;
  const colDivider = '-'.repeat(tableWidth);
  let rowsStr = [
    colDivider,
    `| ${title}${' '.repeat(tableWidth - title.length - 4)} |`,
    colDivider
  ]
  if (rows.length) {
    rowsStr = rowsStr.concat([
      ...rows.map(row => {
        const colsStr = row.map((col, colIndex) => col.padEnd(colWidth[colIndex], ' '));
        return '| ' + colsStr.join(' | ') + ' |';
      }),
      colDivider
    ])
  }
  console.log(rowsStr.join('\n'));
}

exports.validateRequired = validateRequired;
exports.removePrefix = removePrefix;
exports.readRemoteFile = readRemoteFile;
exports.listLocalFiles = listLocalFiles;
exports.asyncQueue = asyncQueue;
exports.hashChunk = hashChunk;
exports.splitList = splitList;
exports.taskQueue = taskQueue;
exports.filePath2Uri = filePath2Uri;
exports.drawTable = drawTable;
