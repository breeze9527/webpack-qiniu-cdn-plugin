# webpack-qiniu-cdn-plugin
将webpack输出的资源上传至七牛对象存储(kodo)，并修改资源访问链接为指定的CDN链接

## Usage
*webpack.config.js*

```javascript
const QiniuCDNPlugin = require('webpack-qiniu-cdn-plugin');
module.exports = {
  plugins: [
    new QiniuCDNPlugin({
      accessKey: '__access_ket__',
      secretKey: '__secret_key__',
      cdnHost: '__host__',
      bucket: '__bucket__',
      dir: 'access',
      exclude: /\.html$/,
      expire: {
        versions: 1,
        time: 60
      },
      refresh: true,
      prefetch: true,
      dry: true
    });
  ]
}
```

## Options
字段名 | 类型 | 描述 | 默认值
-- | -- | -- | --
**accessKey** | string | [七牛accessKey](https://developer.qiniu.com/kodo/manual/3978/the-basic-concept) | -
**secretKey** | string | [七牛secretKey](https://developer.qiniu.com/kodo/manual/3978/the-basic-concept) | -
**bucket** | string | [对象存储bucket](https://developer.qiniu.com/kodo/manual/1728/buckets) | -
**cdnHost** | string | 用于访问DNS资源的[域名](https://developer.qiniu.com/kodo/kb/5859/domain-name-to-access-the-storage-space) | -
dir | string | 存储文件时使用的文件夹前缀，不包括末尾的`/` | `''`
logFile | string | 版本记录文件的文件名 | `'upload-log.json'`
expire | [Expire](#options_expire) \| false | 版本过期策略，`false`表示不过期 | `false`
exclude | RegExp \| function | 选择哪些文件不需要上传，当值为函数是接收文件路径作为参数，返回`true`表示排除该文件 | `() => false`
refresh | boolean | 覆盖上传是否刷新CDN缓存 | `false`
prefetch | boolean | 上传后是否执行CDN预取 | `false`
silent | boolean | 安静模式 | `false`
dry | boolean | 不执行实际的上传删除操作，用于调试 | `false`

*加粗表示必填项*

<h2 id="options_expire">Expire</h2>
可以使用expire选项指定版本过期策略

过期版本中不被使用的文件会被插件从存储空间中删除

`expire`选项包含两个成员

字段名 | 类型 | 描述
-- | -- | --
time | number | 过期时间(秒)
versions | number | 需要保留的版本数

过期时间是指`本次构建时间 - 对应版本构建时间`，即版本的存活时间。
保留版本数是指需要保留的先前版本的数量，不包括当前版本。

同时满足两个条件的会被认为是过期版本(当前时间距离记录的构建时间大于过期时间，并且不在保留版本范围内)
省略某一条件表示不校验该条件

## UploadStatus
当`silent`不为`true`时会在控制台打印下列统计信息：
名称 | 描述
-- | --
remote | 存储空间中现有的文件列表
exclude | 被`exclude`选项排除的文件
overwrite | 覆盖性上传的文件
omit | 忽略上传的文件（存储空间中已存在名称相同且hash相同的文件）
upload | 新上传的文件
clean | 被回收的文件

## Tips
- 不需要在webpack额外设置`output.publicPath`，插件会根据`cdnHost`与`dir`自动设置
- 记录文件的保存路径是`${cdnHost}/${dir}/${logFile}`
- 回收操作只会清除`logFile`中有记录的条目，所以更改`prefix`或是`logFile`选项后需要手动清除旧的资源
- CDN refresh操作只会刷新被覆盖更新的资源
- CDN prefetch操作只会预取新上传的资源
