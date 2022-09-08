import * as core from '@actions/core'
import simpleGit from 'simple-git'
import {SimpleGit} from 'simple-git/promise'
import {URL} from 'url'
import * as util from 'util'
import workspacePath from './internal/workspacePath'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const TAG_REF_PREFIX = 'refs/tags/'

const RESULT = {
    REMOTE_CHANGED: 'remote-changed',
    TAGGED_SUCCESSFULLY: 'tagged-successfully',
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

require('debug').log = function log(...args) {
    return process.stdout.write(`${util.format(...args)}\n`)
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const repositoryFullName = process.env.GITHUB_REPOSITORY
        if (!repositoryFullName) {
            throw new Error('GITHUB_REPOSITORY not defined')
        }

        const githubToken = core.getInput('githubToken', {required: true})
        core.setSecret(githubToken)

        const tagName = core.getInput('tagName', {required: true})

        if (core.isDebug()) {
            require('debug').enable('simple-git')
        }
        const git = simpleGit(workspacePath)

        const currentBranch = await getCurrentBranchName(git)
        const remoteBranch: string | undefined = (function () {
            const remoteBranchInput = core.getInput('remoteBranch')
            if (remoteBranchInput) {
                return remoteBranchInput
            }
            if (currentBranch === 'HEAD') {
                return undefined
            }
            return currentBranch
        })()

        const pushRemoteName = 'push-tag'
        const prevConfigValues: { [key: string]: string } = {}
        try {
            await core.group('Configuring Git committer info', async () => {
                const configuredName = await getGitConfig(git, 'user.name')
                if (configuredName) {
                    core.debug(`Configured committer name: ${configuredName}`)
                    prevConfigValues['user.name'] = configuredName
                }

                const name = core.getInput('committerName')
                    || configuredName
                    || process.env.GITHUB_ACTOR
                    || repositoryFullName.split('/')[0]
                core.info(`Committer name: ${name}`)
                await git.addConfig('user.name', name)

                const configuredEmail = await getGitConfig(git, 'user.email')
                if (configuredEmail) {
                    core.debug(`Configured committer email: ${configuredEmail}`)
                    prevConfigValues['user.email'] = configuredEmail
                }

                const email = core.getInput('committerEmail') || configuredEmail || `${name}@users.noreply.github.com`
                core.info(`Committer email: ${email}`)
                await git.addConfig('user.email', email)
            })

            const serverUrl = new URL(
                process.env['GITHUB_SERVER_URL']
                || process.env['GITHUB_URL']
                || 'https://github.com'
            )
            core.debug(`Server URL: ${serverUrl}`)
            const remoteUrl = new URL(serverUrl.toString())
            if (!remoteUrl.pathname.endsWith('/')) {
                remoteUrl.pathname += '/'
            }
            remoteUrl.pathname += `${repositoryFullName}.git`
            remoteUrl.search = ''
            remoteUrl.hash = ''
            core.debug(`Remote URL: ${remoteUrl}`)

            await core.group(`Adding '${pushRemoteName}' remote`, async () => {
                const configuredRemoteNames = await git.getRemotes()
                    .then(remotes => remotes.map(remote => remote.name))
                core.debug(`Configured remote names: ${configuredRemoteNames.join(', ')}`)
                if (configuredRemoteNames.includes(pushRemoteName)) {
                    throw new Error(`Remote already exists: ${pushRemoteName}`)
                }

                const extraHeaderConfigKey = `http.${serverUrl.origin}/.extraheader`
                const configuredExtraHeader = await getGitConfig(git, extraHeaderConfigKey)
                if (configuredExtraHeader) {
                    prevConfigValues[extraHeaderConfigKey] = configuredExtraHeader
                }

                core.debug('Adding remote')
                await git.addRemote(
                    pushRemoteName,
                    remoteUrl.toString()
                )
                core.info(`Remote added: ${remoteUrl.toString()}`)

                core.info('Setting up credentials')
                const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
                core.setSecret(basicCredentials)
                await git.addConfig(extraHeaderConfigKey, `Authorization: basic ${basicCredentials}`)
            })

            const forcePush = core.getInput('forcePush').toLowerCase() === 'true'
            const isRemoteChanged = await core.group(
                `Creating tag '${tagName}'${forcePush ? ' (force push enabled)' : ''}`,
                async () => {
                    if (remoteBranch) {
                        const targetLatestCommitSha = await getLatestCommitSha(git, pushRemoteName, remoteBranch)
                        if (targetLatestCommitSha) {
                            core.info(`Remote branch '${remoteBranch}' last commit SHA: ${targetLatestCommitSha}`)
                            const currentCommitSha = await getCurrentCommitSha(git)
                            core.info(`HEAD commit SHA: ${currentCommitSha}`)
                            if (targetLatestCommitSha !== currentCommitSha) {
                                return true
                            }
                        } else {
                            throw new Error(`Remote ${remoteUrl.toString()} doesn't have '${remoteBranch}' branch`)
                        }
                    }

                    core.info(`Creating tag '${tagName}'`)
                    const message = core.getInput('message')
                    if (message) {
                        await git.tag(['--force', '-m', message, tagName])
                    } else {
                        await git.tag(['--force', tagName])
                    }

                    core.info(`Pushing tag '${tagName}'`)
                    if (forcePush) {
                        await git.push(pushRemoteName, TAG_REF_PREFIX + tagName, ['--force'])
                    } else {
                        await git.push(pushRemoteName, TAG_REF_PREFIX + tagName)
                    }

                    return false
                }
            )
            if (isRemoteChanged) {
                core.warning(`Remote repository branch '${remoteBranch}' has been changed, skipping tag creation`)
                core.setOutput('result', RESULT.REMOTE_CHANGED)
            } else {
                core.setOutput('result', RESULT.TAGGED_SUCCESSFULLY)
            }

        } catch (error) {
            core.setFailed(error instanceof Error ? error : (error as object).toString())

        } finally {
            await core.group(`Removing '${pushRemoteName}' remote`, async () => {
                await git.removeRemote(pushRemoteName)
            })

            await core.group('Restoring previous config values', async () => {
                for (const key in prevConfigValues) {
                    const value = prevConfigValues[key]
                    await git.addConfig(key, value)
                }
            })
        }
    } catch (error) {
        core.setFailed(error instanceof Error ? error : (error as object).toString())
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function getGitConfig(git: SimpleGit, configKey: string, defaultValue: string = ''): Promise<string> {
    return git.raw('config', '--default', defaultValue, '--get', configKey)
        .then(text => text.trim())
}

async function getCurrentCommitSha(git: SimpleGit): Promise<string> {
    return git.raw('rev-parse', 'HEAD')
        .then(text => text.trim())
}

async function getCurrentBranchName(git: SimpleGit): Promise<string> {
    return git.raw('rev-parse', '--abbrev-ref', 'HEAD')
        .then(text => text.trim())
}

async function getRemoteTags(git: SimpleGit, remoteName: string): Promise<string[]> {
    return git.listRemote(['--tags', remoteName])
        .then(text => text.trim())
        .then(text => text.split('\n')
            .map(line => line.replace(/^[0-9a-f]\s+/, ''))
            .filter(ref => ref.startsWith(TAG_REF_PREFIX))
            .map(ref => ref.substr(TAG_REF_PREFIX.length))
        )
}

async function getLatestCommitSha(git: SimpleGit, remoteName: string, remoteBranch: string): Promise<string> {
    return git.listRemote([remoteName, `refs/heads/${remoteBranch}`])
        .then(text => text.trim())
        .then(text => text.split(/\s/)[0])
}
