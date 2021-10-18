const core = require('@actions/core')
const fs = require('fs-extra')
const path = require('path')
const AdmZip = require("adm-zip");
const glob = require("glob")
const ObsClient = require('esdk-obs-nodejs');
const exec = require('@actions/exec');

async function main() {
    let rootProjectPath = core.getInput('path')
    if (!fs.existsSync(rootProjectPath)) {
        core.error('root project path does not exist')
        return;
    }
    let walleCliPath = path.join(rootProjectPath, 'walle-cli-all.jar')
    // 查找 release 文件
    let releasePattern = path.join(rootProjectPath, 'app', 'build', 'outputs', 'apk', '**', 'release', '*.apk')
    core.info('pattern: ' + releasePattern)
    let releaseSearchFiles = await glob.sync(releasePattern, null)
    core.info('releaseSearchFiles.filed ' + releaseSearchFiles)

    if (releaseSearchFiles.length === 0) {
        core.error('no release file to zip')
        return
    }
    let zipName = 'file.zip'
    // 执行打包命令
    for (let baseReleaseFile of releaseSearchFiles) {
        // 执行打包命令
        if (baseReleaseFile.indexOf('cy_shuidi') !== -1) {
            await exec.exec('java', ['-jar', walleCliPath, 'put', '-c', 'cy_shuidi', baseReleaseFile])
        } else {
            await exec.exec('java', ['-jar', walleCliPath, 'batch2', '-f', path.join(rootProjectPath, 'app', 'config.json'), baseReleaseFile])
        }
        // 删除无渠道配置文件
        zipName = path.basename(baseReleaseFile) + '.zip'
        core.info('zipName: ' + zipName)
        fs.unlinkSync(baseReleaseFile)
    }

    // 查找渠道文件
    let channelSearchFiles = await glob.sync(releasePattern, null)
    core.info('channelSearchFiles.filed ' + releaseSearchFiles)

    if (channelSearchFiles.length === 0) {
        core.error('no channel release file to zip')
        return
    }

    // 压缩文件
    let zip = new AdmZip(null, null);

    for (let channelFile of channelSearchFiles) {
        zip.addLocalFile(channelFile, null, null)
    }

    await zip.writeZipPromise(zipName, null)
    core.info(zipName + ' zip finish , size ' + fs.lstatSync(zipName).size)

    // 上传obs
    let server = core.getInput('endpoint')
    let region = core.getInput('region')
    let signature = core.getInput('signature') || 'obs'
    let ak = core.getInput('ak')
    let sk = core.getInput('sk')
    let bucketName = core.getInput('bucket') || 'github-actions-upload-hk';

    let obs = new ObsClient({
        access_key_id: ak,
        secret_access_key: sk,
        server: 'https://' + server,
        signature: signature,
        region: region,
    });

    let objectKey = path.parse(zipName).base;

    await uploadFile(obs, ak, sk, server, region, zipName, bucketName, objectKey)
}

function uploadFile(obs, ak, sk, server, region, filePath, bucketName, objectKey) {
    return new Promise((resolve, reject) => {
        obs.createBucket({
            Bucket: bucketName,
            Location: region,
        }, (err, result) => {
            console.log('createBucket', err, JSON.stringify(result.CommonMsg))
            if (err) {
                reject(err)
                return
            }
            if (result.CommonMsg.Status < 300) {
                /*
                 * Claim a post object request
                 */
                let formParams = {'content-type': 'text/plain'};
                formParams['x-obs-acl'] = obs.enums.AclPublicRead;
                let res = obs.createPostSignatureSync({
                    Bucket: bucketName,
                    Key: objectKey,
                    Expires: 3600,
                    FormParams: formParams
                });

                /*
                 * Start to post object
                 */
                formParams['key'] = objectKey;
                formParams['policy'] = res['Policy'];
                formParams['Accesskeyid'] = ak;

                formParams['signature'] = res['Signature'];

                let boundary = new Date().getTime();

                /*
                 * Construct form data
                 */
                let buffers = [];
                let first = true;

                let contentLength = 0;

                let buffer = [];
                for (let key in formParams) {
                    if (!first) {
                        buffer.push('\r\n');
                    } else {
                        first = false;
                    }

                    buffer.push('--');
                    buffer.push(boundary);
                    buffer.push('\r\n');
                    buffer.push('Content-Disposition: form-data; name="');
                    buffer.push(String(key));
                    buffer.push('"\r\n\r\n');
                    buffer.push(String(formParams[key]));
                }

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Construct file description
                 */
                buffer = [];
                buffer.push('\r\n');
                buffer.push('--');
                buffer.push(boundary);
                buffer.push('\r\n');
                buffer.push('Content-Disposition: form-data; name="file"; filename="');
                buffer.push('myfile');
                buffer.push('"\r\n');
                buffer.push('Content-Type: text/plain');
                buffer.push('\r\n\r\n');

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Contruct end data
                 */
                buffer = [];
                buffer.push('\r\n--');
                buffer.push(boundary);
                buffer.push('--\r\n');

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Add file length to content length
                 */
                contentLength += fs.lstatSync(filePath).size;

                let http = require('http');
                let req = http.request({
                    method: 'POST',
                    host: bucketName + '.' + server,
                    port: 80,
                    path: '/',
                    headers: {
                        'Content-Length': String(contentLength),
                        'User-Agent': 'OBS/Test',
                        'Content-Type': 'multipart/form-data; boundary=' + boundary
                    }
                });

                req.on('response', (response) => {
                    if (response.statusCode < 300) {
                        core.info('Post object successfully.');
                    } else {
                        core.info('Post object failed!!');
                    }
                    let buffers = [];
                    response.on('data', (data) => {
                        buffers.push(data);
                    }).on('end', () => {
                        if (buffers.length > 0) {
                            core.info(buffers.toString());
                        }
                        resolve()
                    });

                }).on('error', (err) => {
                    core.error(err);
                    reject(err);
                });

                /*
                 * Send form data
                 */
                req.write(buffers[0]);

                /*
                 * Send file description
                 */
                req.write(buffers[1]);

                /*
                 * Send file data
                 */
                let readable = fs.createReadStream(filePath);
                readable.on('data', (data) => {
                    //core.info('write --> ' + data.length)
                    req.write(data);
                }).on('end', () => {
                    /*
                     * Send end data
                     */
                    req.write(buffers[2]);
                    req.end();
                    core.info('write --> finish')
                }).on('err', () => {
                    req.abort();
                    reject()
                });
            } else {
                reject()
            }
        });
    })
}

main().then(function () {
    core.info('finish')
}).catch(function (err) {
    core.error(err)
})