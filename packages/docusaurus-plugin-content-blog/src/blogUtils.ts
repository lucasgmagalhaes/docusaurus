/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import chalk from 'chalk';
import path from 'path';
import readingTime from 'reading-time';
import {Feed} from 'feed';
import {compact, keyBy, mapValues} from 'lodash';
import {
  PluginOptions,
  BlogPost,
  BlogContentPaths,
  BlogMarkdownLoaderOptions,
} from './types';
import {
  parseMarkdownFile,
  normalizeUrl,
  aliasedSitePath,
  getEditUrl,
  getFolderContainingFile,
  posixPath,
  replaceMarkdownLinks,
  Globby,
} from '@docusaurus/utils';
import {LoadContext} from '@docusaurus/types';
import {validateBlogPostFrontMatter} from './blogFrontMatter';

export function truncate(fileString: string, truncateMarker: RegExp): string {
  return fileString.split(truncateMarker, 1).shift()!;
}

export function getSourceToPermalink(
  blogPosts: BlogPost[],
): Record<string, string> {
  return mapValues(
    keyBy(blogPosts, (item) => item.metadata.source),
    (v) => v.metadata.permalink,
  );
}

const DATE_FILENAME_REGEX = /^(?<date>\d{4}[-\/]\d{1,2}[-\/]\d{1,2})[-\/]?(?<text>.*?)(\/index)?.mdx?$/;

type ParsedBlogFileName = {
  date: Date | undefined;
  text: string;
  slug: string;
};

export function parseBlogFileName(
  blogSourceRelative: string,
): ParsedBlogFileName {
  const dateFilenameMatch = blogSourceRelative.match(DATE_FILENAME_REGEX);
  if (dateFilenameMatch) {
    const dateString = dateFilenameMatch.groups!.date!;
    const text = dateFilenameMatch.groups!.text!;
    // Always treat dates as UTC by adding the `Z`
    const date = new Date(`${dateString}Z`);
    // TODO use replaceAll once we require NodeJS 16
    const slugDate = dateString.replace('-', '/').replace('-', '/');
    const slug = `/${slugDate}/${text}`;
    return {
      date,
      text,
      slug,
    };
  } else {
    const text = blogSourceRelative.replace(/(\/index)?\.mdx?$/, '');
    const slug = `/${text}`;
    return {
      date: undefined,
      text,
      slug,
    };
  }
}

function formatBlogPostDate(locale: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch (e) {
    throw new Error(`Can't format blog post date "${date}"`);
  }
}

export async function generateBlogFeed(
  contentPaths: BlogContentPaths,
  context: LoadContext,
  options: PluginOptions,
): Promise<Feed | null> {
  if (!options.feedOptions) {
    throw new Error(
      'Invalid options: "feedOptions" is not expected to be null.',
    );
  }
  const {siteConfig} = context;
  const blogPosts = await generateBlogPosts(contentPaths, context, options);
  if (!blogPosts.length) {
    return null;
  }

  const {feedOptions, routeBasePath} = options;
  const {url: siteUrl, baseUrl, title, favicon} = siteConfig;
  const blogBaseUrl = normalizeUrl([siteUrl, baseUrl, routeBasePath]);

  const updated =
    (blogPosts[0] && blogPosts[0].metadata.date) ||
    new Date('2015-10-25T16:29:00.000-07:00');

  const feed = new Feed({
    id: blogBaseUrl,
    title: feedOptions.title || `${title} Blog`,
    updated,
    language: feedOptions.language,
    link: blogBaseUrl,
    description: feedOptions.description || `${siteConfig.title} Blog`,
    favicon: favicon ? normalizeUrl([siteUrl, baseUrl, favicon]) : undefined,
    copyright: feedOptions.copyright,
  });

  blogPosts.forEach((post) => {
    const {
      id,
      metadata: {title: metadataTitle, permalink, date, description},
    } = post;
    feed.addItem({
      title: metadataTitle,
      id,
      link: normalizeUrl([siteUrl, permalink]),
      date,
      description,
    });
  });

  return feed;
}

async function parseBlogPostMarkdownFile(blogSourceAbsolute: string) {
  const result = await parseMarkdownFile(blogSourceAbsolute, {
    removeContentTitle: true,
  });
  return {
    ...result,
    frontMatter: validateBlogPostFrontMatter(result.frontMatter),
  };
}

async function processBlogSourceFile(
  blogSourceRelative: string,
  contentPaths: BlogContentPaths,
  context: LoadContext,
  options: PluginOptions,
): Promise<BlogPost | undefined> {
  const {
    siteConfig: {baseUrl},
    siteDir,
    i18n,
  } = context;
  const {routeBasePath, truncateMarker, showReadingTime, editUrl} = options;

  // Lookup in localized folder in priority
  const blogDirPath = await getFolderContainingFile(
    getContentPathList(contentPaths),
    blogSourceRelative,
  );

  const blogSourceAbsolute = path.join(blogDirPath, blogSourceRelative);

  const {
    frontMatter,
    content,
    contentTitle,
    excerpt,
  } = await parseBlogPostMarkdownFile(blogSourceAbsolute);

  const aliasedSource = aliasedSitePath(blogSourceAbsolute, siteDir);

  if (frontMatter.draft && process.env.NODE_ENV === 'production') {
    return undefined;
  }

  if (frontMatter.id) {
    console.warn(
      chalk.yellow(
        `"id" header option is deprecated in ${blogSourceRelative} file. Please use "slug" option instead.`,
      ),
    );
  }

  const parsedBlogFileName = parseBlogFileName(blogSourceRelative);

  async function getDate(): Promise<Date> {
    // Prefer user-defined date.
    if (frontMatter.date) {
      return new Date(frontMatter.date);
    } else if (parsedBlogFileName.date) {
      return parsedBlogFileName.date;
    } else {
      // Fallback to file create time
      return (await fs.stat(blogSourceAbsolute)).birthtime;
    }
  }

  const date = await getDate();
  const formattedDate = formatBlogPostDate(i18n.currentLocale, date);

  const title = frontMatter.title ?? contentTitle ?? parsedBlogFileName.text;
  const description = frontMatter.description ?? excerpt ?? '';

  const slug = frontMatter.slug || parsedBlogFileName.slug;

  const permalink = normalizeUrl([baseUrl, routeBasePath, slug]);

  function getBlogEditUrl() {
    const blogPathRelative = path.relative(
      blogDirPath,
      path.resolve(blogSourceAbsolute),
    );

    if (typeof editUrl === 'function') {
      return editUrl({
        blogDirPath: posixPath(path.relative(siteDir, blogDirPath)),
        blogPath: posixPath(blogPathRelative),
        permalink,
        locale: i18n.currentLocale,
      });
    } else if (typeof editUrl === 'string') {
      const isLocalized = blogDirPath === contentPaths.contentPathLocalized;
      const fileContentPath =
        isLocalized && options.editLocalizedFiles
          ? contentPaths.contentPathLocalized
          : contentPaths.contentPath;

      const contentPathEditUrl = normalizeUrl([
        editUrl,
        posixPath(path.relative(siteDir, fileContentPath)),
      ]);

      return getEditUrl(blogPathRelative, contentPathEditUrl);
    } else {
      return undefined;
    }
  }

  return {
    id: frontMatter.slug ?? title,
    metadata: {
      permalink,
      editUrl: getBlogEditUrl(),
      source: aliasedSource,
      title,
      description,
      date,
      formattedDate,
      tags: frontMatter.tags ?? [],
      readingTime: showReadingTime ? readingTime(content).minutes : undefined,
      truncated: truncateMarker?.test(content) || false,
    },
  };
}

export async function generateBlogPosts(
  contentPaths: BlogContentPaths,
  context: LoadContext,
  options: PluginOptions,
): Promise<BlogPost[]> {
  const {include, exclude} = options;

  if (!fs.existsSync(contentPaths.contentPath)) {
    return [];
  }

  const blogSourceFiles = await Globby(include, {
    cwd: contentPaths.contentPath,
    ignore: exclude,
  });

  const blogPosts: BlogPost[] = compact(
    await Promise.all(
      blogSourceFiles.map(async (blogSourceFile: string) => {
        try {
          return await processBlogSourceFile(
            blogSourceFile,
            contentPaths,
            context,
            options,
          );
        } catch (e) {
          console.error(
            chalk.red(
              `Processing of blog source file failed for path "${blogSourceFile}"`,
            ),
          );
          throw e;
        }
      }),
    ),
  );

  blogPosts.sort(
    (a, b) => b.metadata.date.getTime() - a.metadata.date.getTime(),
  );

  return blogPosts;
}

export type LinkifyParams = {
  filePath: string;
  fileString: string;
} & Pick<
  BlogMarkdownLoaderOptions,
  'sourceToPermalink' | 'siteDir' | 'contentPaths' | 'onBrokenMarkdownLink'
>;

export function linkify({
  filePath,
  contentPaths,
  fileString,
  siteDir,
  sourceToPermalink,
  onBrokenMarkdownLink,
}: LinkifyParams): string {
  const {newContent, brokenMarkdownLinks} = replaceMarkdownLinks({
    siteDir,
    fileString,
    filePath,
    contentPaths,
    sourceToPermalink,
  });

  brokenMarkdownLinks.forEach((l) => onBrokenMarkdownLink(l));

  return newContent;
}

// Order matters: we look in priority in localized folder
export function getContentPathList(contentPaths: BlogContentPaths): string[] {
  return [contentPaths.contentPathLocalized, contentPaths.contentPath];
}
