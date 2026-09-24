// ── Search handling ──────────────────────────────────────────────────────────────

searchBtn.addEventListener('click', () => {
    const isVisible = searchPanel.style.display !== 'none';
    searchPanel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        searchInput.focus();
    } else {
        clearSearch();
    }
});

searchInput.addEventListener('input', () => {
    performSearch(searchInput.value);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
            navigateSearch(-1);
        } else {
            navigateSearch(1);
        }
    } else if (e.key === 'Escape') {
        clearSearch();
        searchPanel.style.display = 'none';
    }
});

searchPrevBtn.addEventListener('click', () => navigateSearch(-1));
searchNextBtn.addEventListener('click', () => navigateSearch(1));
searchClearBtn.addEventListener('click', () => {
    clearSearch();
    searchPanel.style.display = 'none';
});

function performSearch(query) {
    searchQuery = query.trim().toLowerCase();
    
    // Clear previous highlights efficiently
    const highlights = document.querySelectorAll('.search-highlight');
    highlights.forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent || ''), el);
        }
    });
    // Normalize all text nodes after clearing highlights
    document.querySelectorAll('.msg-content').forEach(content => {
        content.normalize();
    });
    
    searchMatches = [];
    searchCurrentIndex = -1;
    
    if (!searchQuery) {
        // Show all messages
        document.querySelectorAll('.message').forEach(msg => {
            msg.classList.remove('search-hidden');
        });
        searchResults.textContent = '';
        return;
    }
    
    // Search through messages
    const messages = document.querySelectorAll('.message');
    messages.forEach(msg => {
        const content = msg.querySelector('.msg-content');
        if (!content) return;
        
        const text = content.textContent.toLowerCase();
        if (text.includes(searchQuery)) {
            searchMatches.push(msg);
            msg.classList.remove('search-hidden');
            highlightInElement(content, searchQuery);
        } else {
            msg.classList.add('search-hidden');
        }
    });
    
    // Update results counter
    if (searchMatches.length > 0) {
        searchCurrentIndex = 0;
        updateSearchResults();
        scrollToCurrentMatch();
    } else {
        searchResults.textContent = 'No results';
    }
}

function highlightInElement(element, query) {
    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
    );
    
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
        const text = node.textContent.toLowerCase();
        if (text.includes(query)) {
            nodesToReplace.push(node);
        }
    }
    
    nodesToReplace.forEach(node => {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        const fragments = [];
        let lastIndex = 0;
        let index = lowerText.indexOf(query);
        
        while (index !== -1) {
            // Add text before match
            if (index > lastIndex) {
                fragments.push(document.createTextNode(text.substring(lastIndex, index)));
            }
            
            // Add highlighted match
            const span = document.createElement('span');
            span.className = 'search-highlight';
            span.textContent = text.substring(index, index + query.length);
            fragments.push(span);
            
            lastIndex = index + query.length;
            index = lowerText.indexOf(query, lastIndex);
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
            fragments.push(document.createTextNode(text.substring(lastIndex)));
        }
        
        // Replace node with fragments
        const parent = node.parentNode;
        fragments.forEach(frag => parent.insertBefore(frag, node));
        parent.removeChild(node);
    });
}

function navigateSearch(direction) {
    if (searchMatches.length === 0) return;
    
    searchCurrentIndex = (searchCurrentIndex + direction + searchMatches.length) % searchMatches.length;
    updateSearchResults();
    scrollToCurrentMatch();
}

function updateSearchResults() {
    if (searchMatches.length === 0) {
        searchResults.textContent = 'No results';
        return;
    }
    
    searchResults.textContent = `${searchCurrentIndex + 1} of ${searchMatches.length}`;
    
    // Update current highlight
    document.querySelectorAll('.search-highlight.current').forEach(el => {
        el.classList.remove('current');
    });
    
    const currentMsg = searchMatches[searchCurrentIndex];
    const firstHighlight = currentMsg.querySelector('.search-highlight');
    if (firstHighlight) {
        firstHighlight.classList.add('current');
    }
}

function scrollToCurrentMatch() {
    if (searchCurrentIndex < 0 || searchCurrentIndex >= searchMatches.length) return;
    
    const currentMsg = searchMatches[searchCurrentIndex];
    currentMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearSearch() {
    searchInput.value = '';
    searchQuery = '';
    searchMatches = [];
    searchCurrentIndex = -1;
    searchResults.textContent = '';
    
    // Remove all highlights efficiently
    const highlights = document.querySelectorAll('.search-highlight');
    highlights.forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent || ''), el);
        }
    });
    // Normalize all text nodes after clearing highlights
    document.querySelectorAll('.msg-content').forEach(content => {
        content.normalize();
    });
    
    // Show all messages
    document.querySelectorAll('.message').forEach(msg => {
        msg.classList.remove('search-hidden');
    });
}

