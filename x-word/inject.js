// inject.js - Runs in the MAIN world to inspect React Fiber structures on X.com

(function() {
  console.log("X-Rapor Helper inject.js MAIN world script initialized.");

  function tagTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]:not([data-react-tagged])');
    if (articles.length === 0) return;

    articles.forEach(article => {
      try {
        const key = Object.keys(article).find(k => 
          k.startsWith('__reactProps$') || 
          k.startsWith('__reactFiber$') || 
          k.startsWith('__reactContainer$')
        );
        if (!key) return;
        const fiber = article[key];

        // Traverse React tree to find the tweet object
        let curr = fiber;
        let tweetData = null;
        while (curr) {
          if (curr.memoizedProps && curr.memoizedProps.tweet) {
            tweetData = curr.memoizedProps.tweet;
            break;
          }
          if (curr.props && curr.props.tweet) {
            tweetData = curr.props.tweet;
            break;
          }
          curr = curr.return;
          if (curr && curr.type && curr.type === 'body') break;
        }

        // Mark as processed
        article.setAttribute('data-react-tagged', 'true');

        if (tweetData) {
          // 1. Is Retweet
          const isRt = !!tweetData.retweeted_status;
          article.setAttribute('data-is-retweet', isRt ? 'true' : 'false');

          // 2. Is Self Retweet
          let isSelfRt = false;
          if (isRt && tweetData.user && tweetData.retweeted_status.user) {
            isSelfRt = tweetData.user.screen_name.toLowerCase() === tweetData.retweeted_status.user.screen_name.toLowerCase();
          }
          article.setAttribute('data-is-self-retweet', isSelfRt ? 'true' : 'false');

          // 3. Is Reply & Reply To
          let isReply = false;
          let replyTo = "";
          if (tweetData.in_reply_to_screen_name) {
            isReply = true;
            replyTo = tweetData.in_reply_to_screen_name.toLowerCase();
          } else if (tweetData.in_reply_to_status_id_str || tweetData.in_reply_to_user_id_str) {
            isReply = true;
          }
          article.setAttribute('data-is-reply', isReply ? 'true' : 'false');
          article.setAttribute('data-reply-to', replyTo);

          // 4. Timeline ID (for Snowflake UTC time computation)
          // For RTs, tweetData.id_str is the RT action's Snowflake ID (correct for timeline placement date)
          // For normal tweets, it is the tweet ID itself.
          const tweetId = tweetData.id_str || "";
          article.setAttribute('data-tweet-id', tweetId);
          
          // 5. Author Username & Name
          let author = "";
          let authorName = "";
          if (isRt && tweetData.retweeted_status.user) {
            author = tweetData.retweeted_status.user.screen_name.toLowerCase();
            authorName = tweetData.retweeted_status.user.name || "";
          } else if (tweetData.user) {
            author = tweetData.user.screen_name.toLowerCase();
            authorName = tweetData.user.name || "";
          }
          article.setAttribute('data-author-username', author);
          article.setAttribute('data-author-name', authorName);
        }
      } catch (e) {
        // Silent error
      }
    });
  }

  // Periodic polling for untagged tweets (highly efficient on :not([data-react-tagged]))
  setInterval(tagTweets, 300);
})();
