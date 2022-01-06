import path from 'path'
import gracefulFs from 'graceful-fs'
import grayMatter from 'gray-matter'
import slash from 'slash'
import { LoaderContext } from 'webpack'

import filterRouteLocale from './filter-route-locale'
import { addPage } from './content-dump'
import {
  existsSync,
  getLocaleFromFilename,
  removeExtension,
  getFileName,
  parseJsonFile
} from './utils'
import { compileMdx } from './compile'
import type { LoaderOptions, PageMapItem, PageMapResult } from './types'

const { promises: fs } = gracefulFs
const extension = /\.mdx?$/
const metaExtension = /meta\.?([a-zA-Z-]+)?\.json/
const isProductionBuild = process.env.NODE_ENV === 'production'

// TODO: create this as a webpack plugin.
const indexContentEmitted = new Set()

function findPagesDir(dir: string = process.cwd()): string {
  // prioritize ./pages over ./src/pages
  if (existsSync(path.join(dir, 'pages'))) return 'pages'
  if (existsSync(path.join(dir, 'src/pages'))) return 'src/pages'

  throw new Error(
    "> Couldn't find a `pages` directory. Please create one under the project root"
  )
}

async function getPageMap(currentResourcePath: string): Promise<PageMapResult> {
  const activeRouteLocale = getLocaleFromFilename(currentResourcePath)
  let activeRoute = ''
  let activeRouteTitle: string = ''

  async function getFiles(dir: string, route: string): Promise<PageMapItem[]> {
    const files = await fs.readdir(dir, { withFileTypes: true })
    let dirMeta: Record<
      string,
      string | { [key: string]: string; title: string }
    > = {}

    // go through the directory
    const items = (
      await Promise.all(
        files.map(async f => {
          const filePath = path.resolve(dir, f.name)
          const fileRoute = slash(
            path.join(route, removeExtension(f.name).replace(/^index$/, ''))
          )

          if (f.isDirectory()) {
            if (fileRoute === '/api') return null

            const children = await getFiles(filePath, fileRoute)
            if (!children || !children.length) return null

            return {
              name: f.name,
              children,
              route: fileRoute
            }
          } else if (extension.test(f.name)) {
            // MDX or MD

            const locale = getLocaleFromFilename(f.name)

            if (filePath === currentResourcePath) {
              activeRoute = fileRoute
            }

            const fileContents = await fs.readFile(filePath, 'utf-8')
            const { data } = grayMatter(fileContents)

            if (Object.keys(data).length) {
              return {
                name: removeExtension(f.name),
                route: fileRoute,
                frontMatter: data,
                locale
              }
            }

            return {
              name: removeExtension(f.name),
              route: fileRoute,
              locale
            }
          } else if (metaExtension.test(f.name)) {
            const content = await fs.readFile(filePath, 'utf-8')
            const meta = parseJsonFile(content, filePath)
            // @ts-expect-error since metaExtension.test(f.name) === true
            const locale = f.name.match(metaExtension)[1]

            if (!activeRouteLocale || locale === activeRouteLocale) {
              dirMeta = meta
            }

            return {
              name: 'meta.json',
              meta,
              locale
            }
          }
        })
      )
    )
      .map(item => {
        if (!item) return
        if (item.route === activeRoute) {
          const metadata = dirMeta[item.name]
          activeRouteTitle =
            (typeof metadata === 'string' ? metadata : metadata.title) ||
            item.name
        }
        return { ...item }
      })
      .filter(Boolean)

    // @ts-expect-error since filter remove all the null and undefined item
    return items
  }

  return [
    await getFiles(path.join(process.cwd(), findPagesDir()), '/'),
    activeRoute,
    activeRouteTitle
  ]
}

async function analyzeLocalizedEntries(
  currentResourcePath: string,
  defaultLocale: string
) {
  const filename = getFileName(currentResourcePath)
  const dir = path.dirname(currentResourcePath)

  const filenameRe = new RegExp(
    '^' + filename + '.[a-zA-Z-]+.(mdx?|jsx?|tsx?|json)$'
  )
  const files = await fs.readdir(dir, { withFileTypes: true })

  let hasSSR = false,
    hasSSG = false,
    defaultIndex = 0
  const filteredFiles = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!filenameRe.test(file.name)) continue

    const content = await fs.readFile(path.join(dir, file.name), 'utf-8')
    const locale = getLocaleFromFilename(file.name)

    // Note: this is definitely not correct, we have to use MDX tokenizer here.
    const exportSSR = /^export .+ getServerSideProps[=| |\(]/m.test(content)
    const exportSSG = /^export .+ getStaticProps[=| |\(]/m.test(content)

    hasSSR = hasSSR || exportSSR
    hasSSG = hasSSG || exportSSG

    if (locale === defaultLocale) defaultIndex = filteredFiles.length

    filteredFiles.push({
      name: file.name,
      locale,
      ssr: exportSSR,
      ssg: exportSSG
    })
  }

  return {
    ssr: hasSSR,
    ssg: hasSSG,
    files: filteredFiles,
    defaultIndex
  }
}

export default async function (
  this: LoaderContext<LoaderOptions>,
  source: string
) {
  const callback = this.async()
  this.cacheable(true)

  if (!isProductionBuild) {
    // Add the entire directory `pages` as the dependency
    // so we can generate the correct page map
    this.addContextDependency(path.resolve(findPagesDir()))
  }

  const options = this.getOptions()
  let {
    theme,
    themeConfig,
    locales,
    defaultLocale,
    unstable_contentDump,
    unstable_staticImage,
    mdxOptions
  } = options

  const { resourcePath, resourceQuery } = this
  const filename = resourcePath.slice(resourcePath.lastIndexOf('/') + 1)
  const fileLocale = getLocaleFromFilename(filename) || 'default'
  const rawEntry = resourceQuery.includes('nextra-raw')

  // Check if there's a theme provided
  if (!theme) {
    throw new Error('No Nextra theme found!')
  }

  if (locales && !rawEntry) {
    // We need to handle the locale router here
    const { files, defaultIndex, ssr, ssg } = await analyzeLocalizedEntries(
      resourcePath,
      defaultLocale
    )

    const i18nEntry = `	
import { useRouter } from 'next/router'	

${files
  .map(
    (file, index) =>
      `import Page_${index}${
        file.ssg || file.ssr
          ? `, { ${
              file.ssg ? 'getStaticProps' : 'getServerSideProps'
            } as page_data_${index} }`
          : ''
      } from './${file.name}?nextra-raw'`
  )
  .join('\n')}

export default function I18NPage (props) {	
  const { locale } = useRouter()	
  ${files
    .map(
      (file, index) =>
        `if (locale === '${file.locale}') {
    return <Page_${index} {...props}/>
  } else `
    )
    .join('')} {	
    return <Page_${defaultIndex} {...props}/>	
  }
}

${
  ssg || ssr
    ? `export async function ${
        ssg ? 'getStaticProps' : 'getServerSideProps'
      } (context) {
  const locale = context.locale
  ${files
    .map(
      (file, index) =>
        `if (locale === '${file.locale}' && ${ssg ? file.ssg : file.ssr}) {
    return page_data_${index}(context)
  } else `
    )
    .join('')} {
    return { props: {} }
  }
}`
    : ''
}
`

    return callback(null, i18nEntry)
  }

  // Generate the page map
  let [pageMap, route, title] = await getPageMap(resourcePath)

  if (locales) {
    const locale = getLocaleFromFilename(filename)
    if (locale) {
      pageMap = filterRouteLocale(pageMap, locale, defaultLocale)
    }
  }

  // Extract frontMatter information if it exists
  let { data, content } = grayMatter(source)

  let layout = theme
  let layoutConfig = themeConfig || null

  // Relative path instead of a package name
  if (theme.startsWith('.') || theme.startsWith('/')) {
    layout = path.resolve(theme)
  }
  if (layoutConfig) {
    layoutConfig = slash(path.resolve(layoutConfig))
  }

  if (isProductionBuild && indexContentEmitted.has(filename)) {
    unstable_contentDump = false
  }

  const { result, titleText, headings, hasH1, structurizedData } =
    await compileMdx(content, mdxOptions, {
      unstable_staticImage,
      unstable_contentDump
    })
  content = result
  content = content.replace('export default MDXContent;', '')

  if (unstable_contentDump) {
    // We only add .MD and .MDX contents
    if (extension.test(filename)) {
      await addPage({
        fileLocale,
        route,
        title,
        data,
        structurizedData
      })
    }

    indexContentEmitted.add(filename)
  }

  const prefix = `import withLayout from '${layout}'
import { withSSG } from 'nextra/ssg'
${layoutConfig ? `import layoutConfig from '${layoutConfig}'` : ''}`

  const suffix = `export default function NextraPage (props) {
    return withSSG(withLayout({
      filename: "${slash(filename)}",
      route: "${slash(route)}",
      meta: ${JSON.stringify(data)},
      pageMap: ${JSON.stringify(pageMap)},
      titleText: ${JSON.stringify(titleText)},
      headings: ${JSON.stringify(headings)},
      hasH1: ${JSON.stringify(hasH1)}
    }, ${layoutConfig ? 'layoutConfig' : 'null'}))({
      ...props,
      MDXContent,
      children: <MDXContent/>
    })
}`

  // Add imports and exports to the source
  return callback(null, prefix + '\n\n' + content + '\n\n' + suffix)
}
